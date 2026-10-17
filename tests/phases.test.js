/**
 * The phases in isolation: the inputs and the plan they make, the whole-run mode decision of
 * prepare, the checks run makes before Playwright starts, the trust rule and the report merge of
 * finish, the compare-and-swap steps of the store and the summary.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parsePlan,
  prepareInputs,
  readInputs,
  workingDirectory,
  writeInputs,
} = require('../lib/inputs');
const prepare = require('../lib/prepare');
const run = require('../lib/run');
const finish = require('../lib/finish');
const store = require('../lib/store');
const { fetchJobs, markdown, overheadFrom, simulate } = require('../lib/summary');
const { applyRun, emptyHistory, serializeHistory } = require('../lib/history');
const { CACHE_PATH, HISTORY_FILE, cacheKey, fingerprint } = require('../lib/identity');
const { testKey } = require('../lib/plan/estimate');
const { sha256 } = require('../lib/util');
const { FIXTURE } = require('./support/fixture');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A workspace with the fixture's lockfile under `app`, and the env of a job in it. */
function job({ version = null } = {}) {
  const ws = tmp('psp-phase-');
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  const lock = version
    ? JSON.stringify({ packages: { 'node_modules/@playwright/test': { version } } })
    : fs.readFileSync(path.join(FIXTURE, 'package-lock.json'), 'utf8');
  fs.writeFileSync(path.join(app, 'package-lock.json'), lock);
  return {
    ws,
    app,
    env: {
      GITHUB_WORKSPACE: ws,
      RUNNER_TEMP: tmp('psp-temp-'),
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'c0ffee',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
    },
  };
}

const inputs = (extra = {}) => ({
  ...readInputs({}),
  phase: 'prepare',
  shards: '3',
  command: 'npx playwright test',
  'working-directory': 'app',
  enabled: 'true',
  ...extra,
});

function restore(j, plan, history) {
  const dir = path.join(j.ws, CACHE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, HISTORY_FILE),
    typeof history === 'string' ? history : serializeHistory(history)
  );
  return { ...j.env, PSP_MATCHED_KEY: cacheKey(plan.key, 9, 4) };
}

const someHistory = (key) =>
  applyRun(emptyHistory(key), {
    id: 1,
    attempt: 1,
    commit: 'c',
    fingerprint: 'f',
    date: '2026-10-16',
    samples: new Map([[testKey('chromium', 'a.spec.js', ['x']), 100]]),
  }).history;

describe('inputs', () => {
  test('the first step stores the inputs without the token; later steps read them back', () => {
    const j = job();
    const file = writeInputs({ ...inputs(), plan: '{"v":1}', 'github-token': 'ghs_secret' }, j.env);
    assert.ok(file.startsWith(j.env.RUNNER_TEMP));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /ghs_secret|github-token/);
    assert.notStrictEqual(writeInputs(inputs(), j.env), file, 'one file per invocation');
    const read = readInputs({ PSP_INPUTS_FILE: file, PSP_INPUT_GITHUB_TOKEN: 'ghs_own' });
    assert.strictEqual(read.plan, '{"v":1}');
    assert.strictEqual(read.command, 'npx playwright test');
    assert.strictEqual(read['github-token'], 'ghs_own');
  });

  test('the history key changes with the command, workers, runner label and history-key', () => {
    const j = job();
    const key = (extra, env = j.env) => prepareInputs(inputs(extra), env).key;
    const base = key({});
    assert.notStrictEqual(key({ command: 'npx playwright test --project=chromium' }), base);
    assert.notStrictEqual(key({ workers: '2' }), base);
    assert.notStrictEqual(key({ 'runner-label': 'big' }), base);
    assert.notStrictEqual(key({ 'history-key': 'staging' }), base);
    assert.notStrictEqual(key({}, { ...j.env, RUNNER_ARCH: 'ARM64' }), base);
    assert.strictEqual(key({ shards: '5' }), base, 'the shard count does not split the history');
  });

  test('refuses bad shards, workers, enabled and a directory outside the workspace', () => {
    const j = job();
    assert.throws(() => prepareInputs(inputs({ shards: '0' }), j.env), /shards input/);
    assert.throws(() => prepareInputs(inputs({ shards: '257' }), j.env), /shards input/);
    assert.throws(() => prepareInputs(inputs({ workers: 'x' }), j.env), /workers input/);
    assert.throws(() => prepareInputs(inputs({ enabled: 'yes' }), j.env), /enabled input/);
    assert.throws(() => workingDirectory('../x', j.ws), /outside the workspace/);
    assert.strictEqual(workingDirectory('..e2e', j.ws), '..e2e');
    assert.throws(
      () => prepareInputs(inputs({ command: 'npx playwright test --shard=1/2' }), j.env),
      /--shard/
    );
  });
});

describe('prepare decides the mode of the whole run', () => {
  const planOf = (result) => JSON.parse(result.outputs.plan);

  test('enabled false: disabled, nothing restored', () => {
    const j = job();
    assert.strictEqual(
      prepare.key({ inputs: inputs({ enabled: 'false' }), env: j.env }).outputs.restore,
      'false'
    );
    const result = prepare.plan({ inputs: inputs({ enabled: 'false' }), env: j.env });
    assert.strictEqual(planOf(result).mode, 'disabled');
    assert.deepStrictEqual(JSON.parse(result.outputs.matrix), { shard: [1, 2, 3] });
    assert.strictEqual(result.outputs.mode, 'disabled');
    assert.strictEqual(result.outputs.reason, 'the enabled input is false');
    assert.match(
      result.summary,
      /Mode \*\*disabled\*\* for all 3 shards: the enabled input is false/
    );
  });

  test('Playwright 1.62 has no --add-reporter: disabled; 1.63 restores history', () => {
    const old = job({ version: '1.62.0' });
    const oldPlan = planOf(prepare.plan({ inputs: inputs(), env: old.env }));
    assert.strictEqual(oldPlan.mode, 'disabled');
    assert.match(oldPlan.reason, /below 1\.63\.0/);
    const ok = job({ version: '1.63.0' });
    assert.strictEqual(prepare.key({ inputs: inputs(), env: ok.env }).outputs.restore, 'true');
  });

  test('no Playwright version found: disabled', () => {
    const j = job();
    fs.rmSync(path.join(j.app, 'package-lock.json'));
    const plan = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
    assert.strictEqual(plan.mode, 'disabled');
    assert.match(plan.reason, /no Playwright version/);
  });

  test("Yarn Plug'n'Play in or above the working directory: disabled", () => {
    const j = job();
    fs.writeFileSync(path.join(j.ws, '.pnp.cjs'), '');
    const plan = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
    assert.strictEqual(plan.mode, 'disabled');
    assert.match(plan.reason, /Plug'n'Play/);
  });

  test('no history: native', () => {
    const j = job();
    const plan = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
    assert.strictEqual(plan.mode, 'native');
    assert.strictEqual(plan.reason, 'no history yet');
    assert.strictEqual(plan.seq, null, 'no entry pinned, so finish may start a chain');
    assert.strictEqual(plan.epoch, null);
    assert.strictEqual(plan.attempt, 1);
    assert.strictEqual(plan.fingerprint, fingerprint(plan.key, plan.playwright));
  });

  test('a valid history: balanced, its bytes the snapshot, its sha in the plan', () => {
    const j = job();
    const first = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
    const history = someHistory(first.key);
    const result = prepare.plan({ inputs: inputs(), env: restore(j, first, history) });
    const plan = planOf(result);
    assert.strictEqual(plan.mode, 'balanced');
    assert.deepStrictEqual([plan.epoch, plan.seq], [9, 4], 'the pinned entry');
    assert.strictEqual(plan.sha, sha256(serializeHistory(history)));
    assert.strictEqual(
      fs.readFileSync(path.join(result.outputs['snapshot-dir'], HISTORY_FILE), 'utf8'),
      serializeHistory(history)
    );
    assert.ok(!fs.existsSync(path.join(j.ws, CACHE_PATH)), 'the restored files are removed');
  });

  for (const [name, content, reason] of [
    ['an empty history', (key) => emptyHistory(key), /has no entries/],
    ['a truncated history', () => '{"schema":"playwright', /not valid JSON/],
    ['a history of another key', () => someHistory('other'), /belongs to history key other/],
  ]) {
    test(`${name}: native for every shard`, () => {
      const j = job();
      const first = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
      const result = prepare.plan({ inputs: inputs(), env: restore(j, first, content(first.key)) });
      assert.strictEqual(planOf(result).mode, 'native');
      assert.match(planOf(result).reason, reason);
    });
  }
});

describe('the plan is bound to its run', () => {
  const j = job();
  const text = prepare.plan({ inputs: inputs(), env: j.env }).outputs.plan;

  test('parses in the same run and commit', () => {
    assert.strictEqual(parsePlan(text, j.env).total, 3);
  });

  test('is refused in another run, at another commit or edited', () => {
    assert.throws(() => parsePlan(text, { ...j.env, GITHUB_RUN_ID: '43' }), /run 42, not this run/);
    assert.throws(() => parsePlan(text, { ...j.env, GITHUB_SHA: 'beef' }), /commit c0ffee/);
    const plan = JSON.parse(text);
    assert.throws(
      () => parsePlan(JSON.stringify({ ...plan, workers: 4 }), j.env),
      /key does not match/
    );
    assert.throws(
      () => parsePlan(JSON.stringify({ ...plan, playwright: '1.70.0' }), j.env),
      /fingerprint/
    );
    assert.throws(() => parsePlan(JSON.stringify({ ...plan, mode: 'other' }), j.env), /not a plan/);
    assert.throws(() => parsePlan('', j.env), /empty/);
  });
});

describe('run checks everything before Playwright starts', () => {
  function planned(mode) {
    const j = job();
    fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(j.app, 'node_modules'), 'dir');
    let env = j.env;
    let result = prepare.plan({ inputs: inputs({ workers: '2' }), env });
    if (mode === 'balanced') {
      env = restore(
        j,
        JSON.parse(result.outputs.plan),
        someHistory(JSON.parse(result.outputs.plan).key)
      );
      result = prepare.plan({ inputs: inputs({ workers: '2' }), env });
    }
    if (mode === 'disabled')
      result = prepare.plan({ inputs: inputs({ workers: '2', enabled: 'false' }), env });
    return { j, plan: result.outputs.plan, snapshotDir: result.outputs['snapshot-dir'] };
  }

  test('balanced: the reporter, the workers and the pinned snapshot', () => {
    const { j, plan, snapshotDir } = planned('balanced');
    const setup = run.setup({ inputs: { plan, shard: '2' }, env: j.env });
    fs.cpSync(snapshotDir, setup.outputs['snapshot-dir'], { recursive: true });
    const cmd = run.command({ inputs: { plan, shard: '2' }, env: j.env });
    assert.deepStrictEqual(cmd.argv.slice(-3), [
      '--shard=2/3',
      '--workers=2',
      `--add-reporter=blob,${run.REPORTER}`,
    ]);
    assert.strictEqual(cmd.env.PSP_MODE, 'balanced');
    assert.strictEqual(cmd.env.PSP_SNAPSHOT_SHA, JSON.parse(plan).sha);
    // The blob reporter writes where the run step uploads from, a folder the Action owns.
    assert.strictEqual(cmd.env.PLAYWRIGHT_BLOB_OUTPUT_DIR, setup.outputs['blob-path']);
    assert.strictEqual(
      cmd.env.PLAYWRIGHT_BLOB_OUTPUT_FILE,
      path.join(setup.outputs['blob-path'], 'report-2.zip')
    );
    assert.ok(setup.outputs['blob-path'].startsWith(j.env.RUNNER_TEMP));
    const key12 = JSON.parse(plan).key.slice(0, 12);
    assert.strictEqual(setup.outputs['blob-name'], `blob-report-${key12}-2-attempt-1`);
  });

  test('balanced: other snapshot bytes or none stop the shard', () => {
    const { j, plan } = planned('balanced');
    const setup = run.setup({ inputs: { plan, shard: '1' }, env: j.env });
    assert.throws(
      () => run.command({ inputs: { plan, shard: '1' }, env: j.env }),
      /snapshot artifact is missing/
    );
    fs.writeFileSync(path.join(setup.outputs['snapshot-dir'], HISTORY_FILE), '{}');
    assert.throws(
      () => run.command({ inputs: { plan, shard: '1' }, env: j.env }),
      /snapshot has sha .* pinned/
    );
  });

  test('disabled: the plain command with --shard and the workers, no reporter, the blob file in the Action folder', () => {
    const { j, plan } = planned('disabled');
    const setup = run.setup({ inputs: { plan, shard: '3' }, env: j.env });
    assert.strictEqual(
      setup.outputs.record,
      'true',
      'a status record stands in for the run record'
    );
    assert.deepStrictEqual(run.command({ inputs: { plan, shard: '3' }, env: j.env }).argv, [
      'npx',
      'playwright',
      'test',
      '--shard=3/3',
      '--workers=2',
    ]);
    const cmd = run.command({ inputs: { plan, shard: '3' }, env: j.env });
    assert.ok(!cmd.argv.some((arg) => arg.startsWith('--add-reporter')));
    assert.deepStrictEqual(cmd.env, run.blobOutput(setup.outputs['blob-path'], 3));
  });

  test('an inherited PLAYWRIGHT_BLOB_OUTPUT_FILE cannot move the reports out of the upload path', () => {
    const { j, plan } = planned('native');
    const setup = run.setup({ inputs: { plan, shard: '1' }, env: j.env });
    const bin = tmp('psp-bin-');
    const seen = path.join(bin, 'env.json');
    fs.writeFileSync(
      path.join(bin, 'npx'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));\n`,
      { mode: 0o755 }
    );
    const env = {
      ...j.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(tmp('psp-elsewhere-'), 'report.zip'),
    };
    assert.strictEqual(run.exec({ inputs: { plan, shard: '1' }, env, stdio: 'ignore' }), 0);
    const child = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.strictEqual(
      child.PLAYWRIGHT_BLOB_OUTPUT_FILE,
      path.join(setup.outputs['blob-path'], 'report-1.zip')
    );
  });

  test('the shard process gets none of the Action inputs, the token above all', () => {
    const { j, plan } = planned('disabled');
    run.setup({ inputs: { plan, shard: '1' }, env: j.env });
    // A stand-in `npx` on the PATH records the environment the user's command would see.
    const bin = tmp('psp-bin-');
    const seen = path.join(bin, 'env.json');
    fs.writeFileSync(
      path.join(bin, 'npx'),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));\n`,
      { mode: 0o755 }
    );
    const env = {
      ...j.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PSP_INPUT_GITHUB_TOKEN: 'ghs_secret',
      PSP_INPUT_PLAN: plan,
      PSP_INPUTS_FILE: path.join(j.env.RUNNER_TEMP, 'psp-inputs-x.json'),
      KEEP_ME: 'yes',
    };
    const status = run.exec({ inputs: { plan, shard: '1' }, env, stdio: 'ignore' });
    assert.strictEqual(status, 0);
    const child = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.deepStrictEqual(
      Object.keys(child).filter((name) => name.startsWith('PSP_INPUT')),
      []
    );
    assert.strictEqual(child.KEEP_ME, 'yes');
  });

  test('a shard outside the plan and another installed Playwright are refused', () => {
    const { j, plan } = planned('native');
    assert.throws(
      () => run.setup({ inputs: { plan, shard: '4' }, env: j.env }),
      /outside the plan/
    );
    const edited = JSON.parse(plan);
    const other = {
      ...edited,
      playwright: '1.63.0',
      fingerprint: fingerprint(edited.key, '1.63.0'),
    };
    assert.throws(
      () => run.command({ inputs: { plan: JSON.stringify(other), shard: '1' }, env: j.env }),
      /read 1\.63\.0 from the lockfile/
    );
  });
});

describe('finish', () => {
  test('publish-history: auto publishes from the default branch, true also from same-repo refs', () => {
    const event = (payload) => {
      const file = path.join(tmp('psp-event-'), 'event.json');
      fs.writeFileSync(file, JSON.stringify(payload));
      return file;
    };
    const repository = { default_branch: 'main' };
    const push = (ref) => ({
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: ref,
      GITHUB_EVENT_PATH: event({ repository }),
    });
    const pr = (full) => ({
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/pull/1/merge',
      GITHUB_EVENT_PATH: event({
        repository,
        pull_request: { head: { repo: full && { full_name: full } } },
      }),
    });
    const trusted = (env, mode) => finish.trust(env, mode).trusted;
    assert.ok(trusted(push('refs/heads/main'), 'auto'));
    assert.strictEqual(trusted(push('refs/heads/feature'), 'auto'), false);
    assert.strictEqual(trusted(pr('o/r'), 'auto'), false);
    assert.ok(trusted(push('refs/heads/feature'), 'true'));
    assert.ok(trusted(pr('o/r'), 'true'));
    assert.strictEqual(trusted(push('refs/heads/main'), 'false'), false);
    const schedule = {
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_PATH: event({ schedule: '0 0 * * *' }),
    };
    assert.ok(trusted(schedule, 'auto'));
    assert.strictEqual(trusted(schedule, 'false'), false);
    for (const mode of ['auto', 'true']) {
      assert.strictEqual(trusted(pr('fork/r'), mode), false);
      assert.strictEqual(trusted(pr(null), mode), false);
      assert.strictEqual(
        trusted({ ...push('refs/heads/main'), GITHUB_EVENT_NAME: 'pull_request_target' }, mode),
        false
      );
    }
    assert.strictEqual(
      trusted({ ...push('refs/heads/main'), GITHUB_EVENT_PATH: event({}) }, 'auto'),
      false
    );
    assert.strictEqual(
      trusted(
        { ...push('refs/heads/main'), GITHUB_EVENT_PATH: path.join(tmp('x'), 'missing.json') },
        'true'
      ),
      false
    );
  });

  test('a truncated record fails the check and publishes nothing', async () => {
    const j = job();
    const plan = prepare.plan({ inputs: inputs(), env: j.env }).outputs.plan;
    const setup = finish.setup({ inputs: { plan }, env: j.env });
    fs.writeFileSync(path.join(setup.outputs['records-dir'], 'record.json'), '{"schema":');
    const result = await finish.check({ inputs: { plan }, env: j.env, fetchImpl: null });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outputs.publish, 'false');
    assert.match(result.summary, /malformed record record\.json/);
  });

  test('merges the blob reports of the latest attempt of each shard', () => {
    const plan = { key: 'k'.repeat(24), runId: 9 };
    const blobs = tmp('psp-blobs-');
    const put = (name, file) => {
      fs.mkdirSync(path.join(blobs, name), { recursive: true });
      fs.writeFileSync(path.join(blobs, name, file), name);
    };
    put('blob-report-kkkkkkkkkkkk-1-attempt-1', 'report-a.zip');
    put('blob-report-kkkkkkkkkkkk-2-attempt-1', 'report-b.zip');
    put('blob-report-kkkkkkkkkkkk-2-attempt-2', 'report-c.zip');
    const merged = path.join(tmp('psp-merged-'), 'm');
    assert.strictEqual(finish.collectBlobs(blobs, merged, plan), 2);
    assert.deepStrictEqual(fs.readdirSync(merged).sort(), [
      'blob-report-kkkkkkkkkkkk-1-attempt-1-report-a.zip',
      'blob-report-kkkkkkkkkkkk-2-attempt-2-report-c.zip',
    ]);
    const single = tmp('psp-single-');
    fs.writeFileSync(path.join(single, 'report.zip'), 'x');
    assert.strictEqual(
      finish.collectBlobs(single, merged, plan),
      1,
      'one artifact lands with no folder'
    );
  });

  test('report merges with the Playwright of the plan, and a failed merge only warns', () => {
    const j = job();
    const plan = prepare.plan({ inputs: inputs(), env: j.env }).outputs.plan;
    const setup = finish.setup({ inputs: { plan }, env: j.env });
    const name = `blob-report-${JSON.parse(plan).key.slice(0, 12)}-1-attempt-1`;
    fs.mkdirSync(path.join(setup.outputs['blob-dir'], name));
    fs.writeFileSync(path.join(setup.outputs['blob-dir'], name, 'report.zip'), 'x');
    const calls = [];
    const ok = finish.report({
      inputs: { plan },
      env: j.env,
      spawn: (cmd, args, options) => {
        calls.push([cmd, ...args]);
        fs.writeFileSync(path.join(options.env.PLAYWRIGHT_HTML_OUTPUT_DIR, 'index.html'), 'x');
        return { status: 0 };
      },
    });
    assert.strictEqual(ok.outputs.merged, 'true');
    assert.deepStrictEqual(calls[0].slice(0, 4), [
      'npx',
      '--yes',
      `playwright@${JSON.parse(plan).playwright}`,
      'merge-reports',
    ]);
    assert.ok(calls[0].includes('--reporter=html'));
    const failed = finish.report({ inputs: { plan }, env: j.env, spawn: () => ({ status: 1 }) });
    assert.strictEqual(failed.outputs.merged, 'false');
    assert.match(failed.annotations[0], /failed with exit 1/);
    // A merge config without an HTML reporter writes nothing here: nothing to upload.
    const empty = finish.report({ inputs: { plan }, env: j.env, spawn: () => ({ status: 0 }) });
    assert.strictEqual(empty.outputs.merged, 'false');
    assert.match(empty.annotations[0], /wrote nothing to upload/);
  });

  test('report merges with the Playwright installed in the working directory, and merge-config', () => {
    const j = job();
    fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(j.app, 'node_modules'), 'dir');
    const plan = JSON.parse(prepare.plan({ inputs: inputs(), env: j.env }).outputs.plan);
    const local = finish.mergeCommand(plan, {}, j.env);
    assert.strictEqual(local.command, process.execPath);
    assert.match(local.args[0], /@playwright[\\/]test[\\/]cli\.js$/);
    assert.deepStrictEqual(local.args.slice(1), ['merge-reports', '--reporter=html']);
    const configured = finish.mergeCommand(plan, { 'merge-config': 'merge.config.js' }, j.env);
    assert.deepStrictEqual(configured.args.slice(1), [
      'merge-reports',
      `--config=${path.join(j.app, 'merge.config.js')}`,
    ]);
    // Under pull_request_target nothing from the checkout runs: npx alone, merge-config ignored.
    const target = finish.mergeCommand(
      plan,
      { 'merge-config': 'merge.config.js' },
      { ...j.env, GITHUB_EVENT_NAME: 'pull_request_target' }
    );
    assert.strictEqual(target.command, 'npx');
    assert.deepStrictEqual(target.args.slice(2), ['merge-reports', '--reporter=html']);
    assert.match(target.warning, /merge-config is ignored under pull_request_target/);
    fs.rmSync(path.join(j.app, 'node_modules'));
    assert.strictEqual(finish.mergeCommand(plan, {}, j.env).command, 'npx');
    assert.strictEqual(finish.mergeCommand({ ...plan, playwright: null }, {}, j.env), null);
  });

  test('conclude outputs the mode, the coverage and the history', async () => {
    const j = job();
    const plan = prepare.plan({ inputs: inputs({ enabled: 'false' }), env: j.env }).outputs.plan;
    finish.setup({ inputs: { plan }, env: j.env });
    const checked = await finish.check({ inputs: { plan }, env: j.env, fetchImpl: null });
    assert.match(checked.summary, /Coverage \*\*not checked\*\*/);
    const out = finish.conclude({ inputs: { plan }, env: j.env }).outputs;
    assert.deepStrictEqual(out, {
      mode: 'disabled',
      coverage: 'not checked',
      history: 'unchanged',
    });
  });
});

describe('the compare-and-swap steps', () => {
  const key = 'key';
  const runOf = (id) => ({
    id,
    attempt: 1,
    commit: 'c',
    fingerprint: 'f',
    date: '2026-10-16',
    samples: [[testKey('p', 'f', ['t']), 100 + id]],
  });
  const entry = (id) =>
    serializeHistory(
      applyRun(emptyHistory(key), { ...runOf(id), samples: new Map(runOf(id).samples) }).history
    );
  const slot = (epoch, seq) => ({ epoch, seq });

  test('a cold history starts a chain under the date of the finish and verifies it', () => {
    const state = store.newState({ key, run: runOf(5) });
    const written = store.write(state, { matchedKey: '', text: null });
    assert.strictEqual(written.key, cacheKey(key, 20261016, 1));
    assert.deepStrictEqual(store.verify(state, { text: written.text }), { retry: false });
    assert.strictEqual(state.status, 'published');
  });

  test('a lost key joins the merge and the next attempt moves past every key seen', () => {
    const state = store.newState({ key, run: runOf(5) });
    store.write(state, { matchedKey: cacheKey(key, 2, 3), text: entry(1) });
    assert.deepStrictEqual(state.attempted, [slot(2, 4)]);
    assert.deepStrictEqual(store.verify(state, { text: entry(2) }), { retry: true });
    const second = store.write(state, { matchedKey: cacheKey(key, 2, 3), text: entry(1) });
    assert.strictEqual(second.key, cacheKey(key, 2, 5));
    assert.deepStrictEqual(JSON.parse(second.text).runs, [1, 2, 5]);
  });

  test('a history that holds the run already saves nothing', () => {
    const state = store.newState({ key, run: runOf(1) });
    assert.strictEqual(
      store.write(state, { matchedKey: cacheKey(key, 1, 1), text: entry(1) }).save,
      false
    );
    assert.strictEqual(state.status, 'already');
  });

  test('a damaged newest entry is an error, counts as seen, and this run is published over it', () => {
    const state = store.newState({ key, run: runOf(7), pinned: slot(3, 1) });
    const written = store.write(state, { matchedKey: cacheKey(key, 3, 1), text: '{' });
    assert.strictEqual(written.key, cacheKey(key, 3, 2));
    assert.deepStrictEqual(JSON.parse(written.text).runs, [7]);
    assert.match(state.errors[0], /not valid JSON/);
    store.verify(state, { text: written.text });
    assert.strictEqual(state.status, 'published');
    assert.throws(
      () => store.write(state, { matchedKey: 'psp-history-v2-other-1-1', text: entry(1) }),
      /outside this history/
    );
    assert.throws(
      () => store.write(state, { matchedKey: `psp-history-v2-${key}-1`, text: entry(1) }),
      /outside this history/
    );
  });

  test('the next key continues the epoch read and is above the entry prepare pinned', () => {
    const state = store.newState({ key, run: runOf(7), pinned: slot(4, 6) });
    assert.strictEqual(
      store.write(state, { matchedKey: cacheKey(key, 4, 2), text: entry(1) }).key,
      cacheKey(key, 4, 7)
    );
  });

  test('higher keys of an older day never block a fresh chain: it publishes on its first attempt', () => {
    // An old chain 20261015-2..4 survives an eviction the cache hides; prepare and finish see nothing.
    const old = new Map([2, 3, 4].map((seq) => [cacheKey(key, 20261015, seq), entry(seq)]));
    const state = store.newState({ key, run: runOf(300) });
    const written = store.write(state, { matchedKey: '', text: null });
    assert.strictEqual(written.key, cacheKey(key, 20261016, 1));
    assert.ok(!old.has(written.key));
    assert.deepStrictEqual(store.verify(state, { text: written.text }), { retry: false });
    assert.strictEqual(state.status, 'published');
    assert.strictEqual(state.attempted.length, 1);
    // The next writer reads the newest entry, the fresh one, and continues its chain.
    const next = store.newState({ key, run: runOf(301), pinned: slot(20261016, 1) });
    assert.strictEqual(
      store.write(next, { matchedKey: written.key, text: written.text }).key,
      cacheKey(key, 20261016, 2)
    );
  });

  test('two cold writers of one day meet on the first key, and the newest entry holds both runs', () => {
    // The Actions cache: immutable keys, the newest entry by prefix.
    const cache = new Map();
    const save = (k, text) => cache.has(k) || cache.set(k, text);
    const newest = () => [...cache.keys()].pop() || '';
    const a = store.newState({ key, run: runOf(401) });
    const b = store.newState({ key, run: runOf(402) });
    const wa = store.write(a, { matchedKey: '', text: null });
    const wb = store.write(b, { matchedKey: '', text: null });
    assert.strictEqual(wa.key, wb.key);
    save(wa.key, wa.text);
    save(wb.key, wb.text);
    assert.deepStrictEqual(store.verify(a, { text: cache.get(wa.key) }), { retry: false });
    assert.deepStrictEqual(store.verify(b, { text: cache.get(wb.key) }), { retry: true });
    const again = store.write(b, { matchedKey: newest(), text: cache.get(newest()) });
    save(again.key, again.text);
    assert.deepStrictEqual(store.verify(b, { text: cache.get(again.key) }), { retry: false });
    assert.strictEqual(newest(), cacheKey(key, 20261016, 2));
    assert.deepStrictEqual(JSON.parse(cache.get(newest())).runs, [401, 402]);
  });

  test('a prefix read that misses after prepare pinned an entry publishes nothing', () => {
    const state = store.newState({ key, run: runOf(7), pinned: slot(1, 3) });
    assert.strictEqual(store.write(state, { matchedKey: '', text: null }).save, false);
    assert.strictEqual(state.status, 'unavailable');
  });

  test('a key another writer is still uploading is tried again on the next attempt', () => {
    const state = store.newState({ key, run: runOf(7), pinned: slot(1, 1) });
    const first = store.write(state, { matchedKey: cacheKey(key, 1, 1), text: entry(1) });
    assert.deepStrictEqual(store.verify(state, { text: null }), { retry: true });
    const second = store.write(state, { matchedKey: cacheKey(key, 1, 1), text: entry(1) });
    assert.strictEqual(second.key, first.key);
    // The other writer finished: its entry joins the merge and the next attempt moves on.
    assert.deepStrictEqual(store.verify(state, { text: entry(2) }), { retry: true });
    const third = store.write(state, { matchedKey: cacheKey(key, 1, 1), text: entry(1) });
    assert.strictEqual(third.key, cacheKey(key, 1, 3));
    assert.deepStrictEqual(JSON.parse(third.text).runs, [1, 2, 7]);
  });

  test(`after ${store.ATTEMPTS} lost attempts the store reports failure`, () => {
    const state = store.newState({ key, run: runOf(9) });
    for (let i = 1; i <= store.ATTEMPTS; i++) {
      store.write(state, { matchedKey: '', text: null });
      const { retry } = store.verify(state, { text: null });
      assert.strictEqual(retry, i < store.ATTEMPTS);
    }
    assert.strictEqual(state.status, 'failed');
    assert.deepStrictEqual(
      state.attempted,
      [slot(20261016, 1), slot(20261016, 1), slot(20261016, 1)],
      'the pending key is retried'
    );
  });
});

describe('summary', () => {
  const record = (shard, runner, wallMs, startedAt = '2026-10-16T00:00:10Z') => ({
    shard: { current: shard, total: 2 },
    run: { id: 1, attempt: 1 },
    runner,
    startedAt,
    wallMs,
    projects: { chromium: [] },
    phases: {},
    tests: [1, 2, 3].map((i) => ({
      id: `${shard}-${i}`,
      key: testKey('chromium', `f${shard}${i}.spec.js`, ['t']),
      repeat: 0,
      setup: false,
      sample_ms: 100 * i,
    })),
  });

  test('simulates this shard count and the next two, with the overhead', () => {
    const rows = simulate([record(1, 'a', 600), record(2, 'b', 600)], {
      counts: [2, 3, 4],
      overheadMs: 1000,
    });
    assert.deepStrictEqual(
      rows.map((r) => r.shards),
      [2, 3, 4]
    );
    assert.ok(rows[0].balancedMs >= rows[2].balancedMs);
    assert.strictEqual(rows[0].elapsedMs, rows[0].balancedMs + 1000);
    assert.strictEqual(simulate([record(1, 'a', 600)], { counts: [2] })[0].elapsedMs, null);
  });

  test('the overhead is the median of job time minus Playwright time, matched by runner', () => {
    const jobs = [
      {
        runner_name: 'a',
        run_attempt: 1,
        started_at: '2026-10-16T00:00:00Z',
        completed_at: '2026-10-16T00:01:00Z',
      },
      {
        runner_name: 'b',
        run_attempt: 1,
        started_at: '2026-10-16T00:00:00Z',
        completed_at: '2026-10-16T00:02:00Z',
      },
    ];
    assert.strictEqual(overheadFrom([record(1, 'a', 10000), record(2, 'b', 20000)], jobs), 75000);
    assert.strictEqual(overheadFrom([record(1, 'zzz', 10000)], jobs), null);
    // A persistent runner keeps its name: only the job that contains the run in time matches.
    const later = [
      { ...jobs[0], started_at: '2026-10-16T01:00:00Z', completed_at: '2026-10-16T01:05:00Z' },
      jobs[0],
    ];
    assert.strictEqual(overheadFrom([record(1, 'a', 10000)], later), 50000);
    assert.strictEqual(overheadFrom([record(1, 'a', 10000, '2026-10-16T02:00:00Z')], jobs), null);
  });

  test('the table, slowest shard, spread and imbalance from known records', () => {
    const plan = { mode: 'balanced', total: 2, reason: 'history entry x', sha: 'a'.repeat(64) };
    const records = [
      {
        ...record(1, 'a', 4000),
        predictedMs: [3000, 3500],
        testsMs: 3800,
        status: 'passed',
        planSha: 'b'.repeat(64),
      },
      {
        ...record(2, 'b', 6000),
        predictedMs: [3000, 3500],
        testsMs: 5900,
        status: 'passed',
        planSha: 'b'.repeat(64),
      },
    ];
    const text = markdown({ plan, check: { ok: true, problems: [], records } });
    assert.match(text, /^### Playwright Smart Parallelization: ok/);
    assert.match(text, /\| 1 \| 1 \| 3 \| 3\.0s \| 4\.0s \| 3\.8s \| passed \|/);
    assert.match(text, /\| 2 \| 1 \| 3 \| 3\.5s \| 6\.0s \| 5\.9s \| passed \|/);
    assert.match(
      text,
      /Slowest shard 2 at 6\.0s, spread 2\.0s, imbalance 20\.0% \(slowest over the mean\)\./
    );
    assert.match(text, /Plan `bbbbbbbbbbbb`\./);
  });

  test('reads the jobs API and reports why it could not', async () => {
    const env = { PSP_INPUT_GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' };
    const ok = await fetchJobs(env, async () => ({
      ok: true,
      json: async () => ({ jobs: [{ id: 1 }] }),
    }));
    assert.deepStrictEqual(ok, { jobs: [{ id: 1 }] });
    const denied = await fetchJobs(env, async () => ({ ok: false, status: 403 }));
    assert.match(denied.error, /403: give the finish job `permissions: actions: read`/);
    const missing = await fetchJobs(
      { ...env, GITHUB_API_URL: 'https://ghe.example/api/v3' },
      async () => ({ ok: false, status: 404 })
    );
    assert.match(missing.error, /404 for run 1 at https:\/\/ghe\.example\/api\/v3/);
    assert.match(missing.error, /permissions: actions: read/);
    const broken = await fetchJobs(env, async () => ({ ok: false, status: 500 }));
    assert.doesNotMatch(broken.error, /actions: read/);
    assert.match((await fetchJobs({}, async () => ({}))).error, /no token/);
  });
});
