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
const { parsePlan, prepareInputs, readInputs, workingDirectory } = require('../lib/inputs');
const prepare = require('../lib/prepare');
const run = require('../lib/run');
const finish = require('../lib/finish');
const store = require('../lib/store');
const { fetchJobs, overheadFrom, simulate } = require('../lib/summary');
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
  return { ...j.env, PSP_MATCHED_KEY: cacheKey(plan.key, 4) };
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
  });

  test('Playwright 1.62 has no --add-reporter: disabled; 1.63 restores history', () => {
    const old = job({ version: '1.62.0' });
    assert.match(planOf(prepare.plan({ inputs: inputs(), env: old.env })).reason, /below 1\.63\.0/);
    const ok = job({ version: '1.63.0' });
    assert.strictEqual(prepare.key({ inputs: inputs(), env: ok.env }).outputs.restore, 'true');
  });

  test('no Playwright version found: disabled', () => {
    const j = job();
    fs.rmSync(path.join(j.app, 'package-lock.json'));
    assert.match(
      planOf(prepare.plan({ inputs: inputs(), env: j.env })).reason,
      /no Playwright version/
    );
  });

  test('no history: native', () => {
    const j = job();
    const plan = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
    assert.strictEqual(plan.mode, 'native');
    assert.strictEqual(plan.reason, 'no history yet');
    assert.strictEqual(plan.fingerprint, fingerprint(plan.key, plan.playwright));
  });

  test('a valid history: balanced, its bytes the snapshot, its sha in the plan', () => {
    const j = job();
    const first = planOf(prepare.plan({ inputs: inputs(), env: j.env }));
    const history = someHistory(first.key);
    const result = prepare.plan({ inputs: inputs(), env: restore(j, first, history) });
    const plan = planOf(result);
    assert.strictEqual(plan.mode, 'balanced');
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
      `--add-reporter=${run.REPORTER}`,
    ]);
    assert.strictEqual(cmd.env.PSP_MODE, 'balanced');
    assert.strictEqual(cmd.env.PSP_SNAPSHOT_SHA, JSON.parse(plan).sha);
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

  test('disabled: the plain command with --shard and the workers, no reporter', () => {
    const { j, plan } = planned('disabled');
    const setup = run.setup({ inputs: { plan, shard: '3' }, env: j.env });
    assert.strictEqual(setup.outputs.record, 'false');
    assert.deepStrictEqual(run.command({ inputs: { plan, shard: '3' }, env: j.env }).argv, [
      'npx',
      'playwright',
      'test',
      '--shard=3/3',
      '--workers=2',
    ]);
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
      KEEP_ME: 'yes',
    };
    const status = run.exec({ inputs: { plan, shard: '1' }, env, stdio: 'ignore' });
    assert.strictEqual(status, 0);
    const child = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.deepStrictEqual(
      Object.keys(child).filter((name) => name.startsWith('PSP_INPUT_')),
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
  test('trusts pushes and same-repository pull requests, never forks or pull_request_target', () => {
    const event = (payload) => {
      const file = path.join(tmp('psp-event-'), 'event.json');
      fs.writeFileSync(file, JSON.stringify(payload));
      return file;
    };
    const base = { GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'push' };
    assert.ok(finish.trust({ ...base, GITHUB_EVENT_PATH: event({}) }).trusted);
    const pr = (full) => ({
      ...base,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event({ pull_request: { head: { repo: full && { full_name: full } } } }),
    });
    assert.ok(finish.trust(pr('o/r')).trusted);
    assert.strictEqual(finish.trust(pr('fork/r')).trusted, false);
    assert.strictEqual(finish.trust(pr(null)).trusted, false);
    assert.strictEqual(
      finish.trust({ ...base, GITHUB_EVENT_NAME: 'pull_request_target' }).trusted,
      false
    );
    assert.strictEqual(
      finish.trust({ ...base, GITHUB_EVENT_PATH: path.join(tmp('x'), 'missing.json') }).trusted,
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
    put('psp-blob-kkkkkkkkkkkk-9-1-attempt-1', 'report-a.zip');
    put('psp-blob-kkkkkkkkkkkk-9-2-attempt-1', 'report-b.zip');
    put('psp-blob-kkkkkkkkkkkk-9-2-attempt-2', 'report-c.zip');
    const merged = path.join(tmp('psp-merged-'), 'm');
    assert.strictEqual(finish.collectBlobs(blobs, merged, plan), 2);
    assert.deepStrictEqual(fs.readdirSync(merged).sort(), [
      'psp-blob-kkkkkkkkkkkk-9-1-attempt-1-report-a.zip',
      'psp-blob-kkkkkkkkkkkk-9-2-attempt-2-report-c.zip',
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
    const name = `psp-blob-${JSON.parse(plan).key.slice(0, 12)}-42-1-attempt-1`;
    fs.mkdirSync(path.join(setup.outputs['blob-dir'], name));
    fs.writeFileSync(path.join(setup.outputs['blob-dir'], name, 'report.zip'), 'x');
    const calls = [];
    const ok = finish.report({
      inputs: { plan },
      env: j.env,
      spawn: (cmd, args) => calls.push([cmd, ...args]) && { status: 0 },
    });
    assert.strictEqual(ok.outputs.merged, 'true');
    assert.deepStrictEqual(calls[0].slice(0, 4), [
      'npx',
      '--yes',
      `playwright@${JSON.parse(plan).playwright}`,
      'merge-reports',
    ]);
    const failed = finish.report({ inputs: { plan }, env: j.env, spawn: () => ({ status: 1 }) });
    assert.strictEqual(failed.outputs.merged, 'false');
    assert.match(failed.annotations[0], /failed with exit 1/);
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

  test('a cold history saves key 1 and verifies it', () => {
    const state = store.newState({ key, run: runOf(5) });
    const written = store.write(state, { matchedKey: '', text: null });
    assert.strictEqual(written.key, cacheKey(key, 1));
    assert.deepStrictEqual(store.verify(state, { text: written.text }), { retry: false });
    assert.strictEqual(state.status, 'published');
  });

  test('a lost key joins the merge and the next attempt moves past every key seen', () => {
    const state = store.newState({ key, run: runOf(5) });
    store.write(state, { matchedKey: cacheKey(key, 3), text: entry(1) });
    assert.deepStrictEqual(state.attempted, [4]);
    assert.deepStrictEqual(store.verify(state, { text: entry(2) }), { retry: true });
    const second = store.write(state, { matchedKey: cacheKey(key, 3), text: entry(1) });
    assert.strictEqual(second.key, cacheKey(key, 5));
    assert.deepStrictEqual(JSON.parse(second.text).runs, [1, 2, 5]);
  });

  test('a history that holds the run already saves nothing', () => {
    const state = store.newState({ key, run: runOf(1) });
    assert.strictEqual(
      store.write(state, { matchedKey: cacheKey(key, 1), text: entry(1) }).save,
      false
    );
    assert.strictEqual(state.status, 'already');
  });

  test('a damaged entry stops the publish', () => {
    const state = store.newState({ key, run: runOf(1) });
    assert.throws(
      () => store.write(state, { matchedKey: cacheKey(key, 1), text: '{' }),
      /not valid JSON/
    );
    assert.throws(
      () => store.write(state, { matchedKey: 'psp-history-v1-other-1', text: entry(1) }),
      /not an entry/
    );
  });

  test(`after ${store.ATTEMPTS} lost attempts the store reports failure`, () => {
    const state = store.newState({ key, run: runOf(9) });
    for (let i = 1; i <= store.ATTEMPTS; i++) {
      store.write(state, { matchedKey: '', text: null });
      const { retry } = store.verify(state, { text: null });
      assert.strictEqual(retry, i < store.ATTEMPTS);
    }
    assert.strictEqual(state.status, 'failed');
  });
});

describe('summary', () => {
  const record = (shard, runner, wallMs) => ({
    shard: { current: shard, total: 2 },
    run: { id: 1, attempt: 1 },
    runner,
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
  });

  test('reads the jobs API and reports why it could not', async () => {
    const env = { PSP_INPUT_GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' };
    const ok = await fetchJobs(env, async () => ({
      ok: true,
      json: async () => ({ jobs: [{ id: 1 }] }),
    }));
    assert.deepStrictEqual(ok, { jobs: [{ id: 1 }] });
    const denied = await fetchJobs(env, async () => ({ ok: false, status: 403 }));
    assert.match(denied.error, /403/);
    assert.match((await fetchJobs({}, async () => ({}))).error, /no token/);
  });
});
