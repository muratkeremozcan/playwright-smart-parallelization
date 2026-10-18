/**
 * The whole Action as a consumer runs it: per shard job the main step, the user's own Playwright
 * command with `$PSP_ARGS`, and the post step, then the optional finish action, through the local
 * model of support/model.js, with real Playwright on a copy of the consumer fixture in a
 * subdirectory and a modeled Actions cache and artifact store. These are the rows of the plan:
 * cold start, a warm run from the history the shards published with no finish, a re-run shard,
 * a failed test, a disabled run, eight shards publishing at once, the command shapes a user writes, a
 * damaged history, a fork pull request and a run without a cache.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cacheRestore,
  cacheSave,
  finishJob,
  newWorld,
  rerunAll,
  shardJob,
} = require('./support/model');
const { FIXTURE, requireFixture } = require('./support/fixture');
const { parseHistory } = require('../lib/history');
const { cacheKey, cachePrefix, pinKey } = require('../lib/identity');
const { sha256 } = require('../lib/util');

// The epoch of a chain the model starts: the day its shards publish on (PSP_TODAY).
const EPOCH = 20261016;

const SELECT = '--project=chromium --grep-invert=oversized --reporter=dot';
const command = (shard, total, extra = '') =>
  `npx playwright test ${SELECT}${extra} --shard=${shard}/${total} $PSP_ARGS`;

/** A workspace with the fixture under `app`, as a checkout with the project in a subdirectory. */
function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-ws-'));
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  for (const file of ['playwright.config.js', 'package-lock.json']) {
    fs.copyFileSync(path.join(FIXTURE, file), path.join(app, file));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
  pkg.scripts = { 'test:pw': 'playwright test' };
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.cpSync(path.join(FIXTURE, 'tests'), path.join(app, 'tests'), { recursive: true });
  fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  return ws;
}

/**
 * Every shard job of one run, each in its own checkout, one after another. `pnp` adds a Yarn
 * Plug'n'Play loader to each checkout, which disables the Action.
 */
async function run(world, runId, total, options = {}) {
  const jobs = [];
  for (let shard = 1; shard <= total; shard++) {
    const ctx = { ws: workspace(), world };
    if (options.pnp) fs.writeFileSync(path.join(ctx.ws, '.pnp.cjs'), '');
    jobs.push(
      await shardJob(ctx, {
        runId,
        cwd: 'app',
        command: command(shard, total, options.extra || ''),
        ...options,
        ...(options.command ? { command: options.command(shard, total) } : {}),
      })
    );
  }
  return jobs;
}

const finishOf = (world, runId, options = {}) =>
  finishJob({ ws: workspace(), world }, { runId, ...options });

function newest(world, key) {
  const found = cacheRestore(world, cachePrefix(key), [cachePrefix(key)]);
  return found.entry
    ? { key: found.matched, text: found.entry.files['history.json'].toString() }
    : null;
}

const keyOf = (jobs) => jobs[0].main.state.key;
const planLines = (out) => out.split('\n').filter((l) => /shard \d\/\d: balanced/.test(l));
const planSha = (job) => /plan ([0-9a-f]{12})/.exec(planLines(job.user.output)[0])[1];
const samplesOf = (history, runId) =>
  Object.entries(history.tests).filter(([, t]) => t.samples.some(([id]) => id === runId));

describe('cold start, a warm run without finish, a re-run shard, a failed test and a disabled run', () => {
  const world = newWorld();
  let cold;
  let warm;

  before(async () => {
    requireFixture();
    cold = await run(world, 101, 2);
    warm = await run(world, 102, 2);
  });

  test('cold: no history, both shards native, each shard publishes its own samples', () => {
    for (const job of cold) {
      assert.strictEqual(job.main.io.outputs.mode, 'native');
      assert.strictEqual(job.main.io.outputs.reason, 'no history yet');
      assert.match(job.main.io.exported.PSP_ARGS, /^--add-reporter=\/\S+reporter\.js$/);
      assert.strictEqual(job.user.status, 0, job.user.output);
      assert.deepStrictEqual(planLines(job.user.output), []);
      assert.deepStrictEqual(job.post.warnings, []);
    }
    const first = parseHistory(
      world.cache.get(cacheKey(keyOf(cold), EPOCH, 2)).files['history.json'].toString()
    );
    assert.deepStrictEqual(first.runs, [101]);
    // Both shards wrote their entry, the second on top of the first.
    assert.ok(world.cache.has(cacheKey(keyOf(cold), EPOCH, 1)));
    const ran = cold.flatMap(
      (job) => JSON.parse(fs.readFileSync(job.main.state.record, 'utf8')).tests
    );
    assert.strictEqual(
      samplesOf(first, 101).length,
      new Set(ran.filter((t) => t.sample_ms).map((t) => t.key)).size
    );
  });

  test('warm, with no finish job before it: balanced from the shard-published history, one plan', () => {
    const pinned = cacheKey(keyOf(cold), EPOCH, 2);
    const bytes = world.cache.get(pinned).files['history.json'].toString();
    for (const job of warm) {
      assert.strictEqual(job.main.io.outputs.mode, 'balanced');
      assert.strictEqual(job.main.io.exported.PSP_SNAPSHOT_SHA, sha256(bytes));
      assert.strictEqual(planLines(job.user.output).length, 1, job.user.output);
    }
    assert.strictEqual(planSha(warm[0]), planSha(warm[1]));
    // The warm shards continue the chain the cold shards started.
    assert.strictEqual(newest(world, keyOf(warm)).key, cacheKey(keyOf(warm), EPOCH, 4));
  });

  test('a re-run of one shard reads the same pin, though the history moved on', async () => {
    const ctx = { ws: workspace(), world };
    const again = await shardJob(ctx, {
      runId: 102,
      attempt: 2,
      cwd: 'app',
      command: command(2, 2),
    });
    assert.match(again.main.io.lines.join('\n'), /read the pin/);
    assert.strictEqual(
      again.main.io.exported.PSP_SNAPSHOT_SHA,
      warm[1].main.io.exported.PSP_SNAPSHOT_SHA
    );
    assert.strictEqual(planSha(again), planSha(warm[1]));
    assert.match(again.post.lines.join('\n'), /already holds these samples|published/);
    const finish = await finishOf(world, 102);
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
    assert.strictEqual(finish.io.outputs['exactly-once'], 'ok');
    assert.strictEqual(finish.io.outputs.mode, 'balanced');
    assert.match(finish.io.summaryText, /\| 2 \| 2 \| /, 'the latest attempt of shard 2');
  });

  test('a re-run after the cache evicted the pin plans from the pin the kept shards hold', async () => {
    const key = pinKey(keyOf(warm), 'test', 102);
    assert.ok(world.cache.delete(key), 'the pin was in the cache');
    const ctx = { ws: workspace(), world };
    const again = await shardJob(ctx, {
      runId: 102,
      attempt: 3,
      cwd: 'app',
      command: command(1, 2),
    });
    assert.match(again.main.io.lines.join('\n'), /bytes the shards that already ran planned from/);
    assert.strictEqual(
      again.main.io.exported.PSP_SNAPSHOT_SHA,
      warm[0].main.io.exported.PSP_SNAPSHOT_SHA
    );
    assert.strictEqual(planSha(again), planSha(warm[0]));
    // It pinned those bytes again, so the next re-run reads them from the cache.
    assert.ok(world.cache.has(key));
    const finish = await finishOf(world, 102);
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
    assert.strictEqual(finish.io.outputs['exactly-once'], 'ok');
  });

  test('finish over the cold run: every test ran exactly once', async () => {
    const finish = await finishOf(world, 101);
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
    assert.deepStrictEqual(
      [finish.io.outputs.mode, finish.io.outputs['exactly-once']],
      ['native', 'ok']
    );
    assert.match(finish.io.summaryText, /Playwright Smart Parallelization, job `test`: ok/);
  });

  test('a failed test: the user step stays red, post publishes the tests that passed, finish fails', async () => {
    const failed = await run(world, 103, 2, { env: { PSP_FIXTURE_FAIL: 'adds an item' } });
    assert.ok(failed.some((job) => job.user.status !== 0));
    const history = parseHistory(newest(world, keyOf(failed)).text);
    const sampled = samplesOf(history, 103).map(([key]) => key);
    assert.ok(sampled.length > 0);
    assert.ok(!sampled.some((key) => key.includes('adds an item')));
    const finish = await finishOf(world, 103);
    assert.match(finish.io.failed, /failed its check/);
    assert.match(finish.io.summaryText, /ended with status failed/);
  });

  test('disabled: PSP_ARGS is empty, the run is plain Playwright, nothing pinned or published', async () => {
    const before = newest(world, keyOf(cold));
    const off = await run(world, 104, 2, { pnp: true });
    for (const job of off) {
      assert.strictEqual(job.main.io.exported.PSP_ARGS, '');
      assert.strictEqual(job.main.io.outputs.mode, 'disabled');
      assert.strictEqual(job.user.status, 0, job.user.output);
      assert.doesNotMatch(job.user.output, /playwright-smart-parallelization/);
    }
    assert.ok(
      ![...world.cache.keys()].some((k) => k.startsWith('psp-pin-') && k.endsWith('-104')),
      'no pin'
    );
    assert.deepStrictEqual(newest(world, keyOf(cold)), before);
    // The jobs API answers two slow pages; a finish with nothing to check still reads them all
    // before it ends, so no request outlives the step and its operation count.
    const pages = [];
    const fetchImpl = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pages.push(url);
      const jobs = Array.from({ length: pages.length === 1 ? 100 : 3 }, (_, i) => ({ id: i }));
      return { ok: true, status: 200, json: async () => ({ jobs }) };
    };
    const finish = await finishOf(world, 104, { inputs: { 'github-token': 't' }, fetchImpl });
    assert.strictEqual(pages.length, 2, 'every page was read before finish returned');
    assert.strictEqual(finish.io.failed, null);
    assert.deepStrictEqual(
      [finish.io.outputs.mode, finish.io.outputs['exactly-once']],
      ['disabled', 'not checked']
    );
  });
});

describe('eight shards publishing at once', () => {
  test('no lost and no doubled sample, and finish proves the run', async () => {
    requireFixture();
    const world = newWorld();
    // The mains and the Playwright runs one after another, then all eight posts at once.
    const { mainStep, userStep, postStep } = require('./support/model');
    const jobs = [];
    for (let shard = 1; shard <= 8; shard++) {
      const ctx = { ws: workspace(), world };
      const main = await mainStep(ctx, { runId: 201, cwd: 'app' });
      jobs.push({ ctx, main, user: userStep(ctx, main, command(shard, 8), { cwd: 'app' }) });
    }
    let seed = 11;
    world.before = async () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      for (let i = seed % 5; i > 0; i--) await new Promise((r) => setImmediate(r));
    };
    const posts = await Promise.all(jobs.map((job) => postStep(job.ctx, job.main)));
    world.before = null;
    for (const p of posts) assert.deepStrictEqual(p.warnings, []);
    const key = jobs[0].main.state.key;
    const entry = newest(world, key);
    const published = posts.filter((p) => p.lines.some((l) => /^published \d+ samples/.test(l)));
    assert.strictEqual(entry.key, cacheKey(key, EPOCH, published.length), 'one entry per shard');
    assert.ok(
      posts.some((p) => p.lines.some((l) => /belongs to another writer|not readable yet/.test(l))),
      'the shards raced'
    );
    const history = parseHistory(entry.text);
    const records = jobs.map((job) => JSON.parse(fs.readFileSync(job.main.state.record, 'utf8')));
    const expected = new Set(
      records.flatMap((r) => r.tests.filter((t) => t.sample_ms).map((t) => t.key))
    );
    assert.deepStrictEqual(new Set(samplesOf(history, 201).map(([k]) => k)), expected);
    for (const [, t] of samplesOf(history, 201)) {
      assert.strictEqual(t.samples.filter(([id]) => id === 201).length, 1);
    }
    const finish = await finishOf(world, 201);
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
  });
});

describe('the command shapes a user writes', () => {
  test('shell variables and a quoted --grep "$FILTER", an npm script, and no --shard', async () => {
    requireFixture();
    const world = newWorld();
    const shell = await run(world, 301, 2, {
      env: { SUITES: 'tests/cart.spec.js tests/catalog.spec.js', FILTER: 'item|catalog' },
      command: (k, n) =>
        `npx playwright test $SUITES --project=chromium --grep "$FILTER" --reporter=dot --shard=${k}/${n} $PSP_ARGS`,
    });
    for (const job of shell) assert.strictEqual(job.user.status, 0, job.user.output);
    const finish = await finishOf(world, 301);
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
    const records = shell.map((job) => JSON.parse(fs.readFileSync(job.main.state.record, 'utf8')));
    assert.ok(records[0].corpus.every(([, label]) => /cart|catalog/.test(label)));

    const npm = await run(world, 302, 2, {
      command: (k, n) => `npm run test:pw -- ${SELECT} --shard=${k}/${n} $PSP_ARGS`,
    });
    for (const job of npm) {
      assert.strictEqual(job.user.status, 0, job.user.output);
      assert.strictEqual(JSON.parse(fs.readFileSync(job.main.state.record, 'utf8')).shard.total, 2);
    }

    const whole = await run(world, 303, 1, {
      command: () => `npx playwright test ${SELECT} $PSP_ARGS`,
    });
    assert.match(whole[0].user.output, /no --shard in the command, so this run is not balanced/);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(whole[0].main.state.record, 'utf8')).shard.total,
      1
    );
  });

  test('a missing $PSP_ARGS leaves a warning and publishes nothing', async () => {
    requireFixture();
    const world = newWorld();
    const [job] = await run(world, 304, 1, {
      command: () => `npx playwright test ${SELECT} --shard=1/2`,
    });
    assert.match(job.post.warnings.join('\n'), /add \$PSP_ARGS/);
    assert.ok(![...world.cache.keys()].some((k) => k.startsWith('psp-history-')));
    const finish = await finishOf(world, 304);
    assert.match(finish.io.summaryText, /no shard of its job left a record.*\$PSP_ARGS is missing/);
    assert.strictEqual(finish.io.outputs['exactly-once'], 'failed');
    assert.ok(finish.io.failed);
  });

  test('two sharded jobs in one run: finish with history-key checks its own', async () => {
    requireFixture();
    const world = newWorld();
    await run(world, 305, 2, { job: 'e2e', inputs: { 'history-key': 'e2e' } });
    // The other job's shard 2 never ran, so it fails its own check.
    const [other] = await run(world, 305, 1, {
      job: 'smoke',
      inputs: { 'history-key': 'smoke' },
      command: (k) => command(k, 2),
    });
    assert.strictEqual(other.main.error, null);
    assert.strictEqual(other.user.status, 0);
    const scoped = await finishOf(world, 305, { inputs: { 'history-key': 'e2e' } });
    assert.strictEqual(scoped.io.failed, null, scoped.io.summaryText);
    const all = await finishOf(world, 305);
    assert.match(all.io.summaryText, /no record for shard 2/);
  });
});

describe('the Action step skipped with an if:', () => {
  test('no main and no post step: plain Playwright, and finish passes with nothing to check', async () => {
    requireFixture();
    const world = newWorld();
    // The user's command alone, as a job whose Action step an if: skipped runs it: $PSP_ARGS is
    // unset, and no start marker, record or status reaches the run.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(PSP_|INPUT_|GITHUB_|RUNNER_)/.test(name))
    );
    for (const shard of [1, 2]) {
      const ws = workspace();
      const user = spawnSync('bash', ['-c', command(shard, 2)], {
        cwd: path.join(ws, 'app'),
        encoding: 'utf8',
        env,
      });
      assert.strictEqual(user.status, 0, user.stderr);
      assert.doesNotMatch(user.stdout, /playwright-smart-parallelization/);
    }
    assert.deepStrictEqual([...world.cache.keys()], []);
    const finish = await finishOf(world, 601);
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
    assert.deepStrictEqual(
      [finish.io.outputs.mode, finish.io.outputs['exactly-once']],
      ['disabled', 'not checked']
    );
    assert.match(finish.io.summaryText, /not run/);
    assert.match(finish.io.summaryText, /No shard of this run ran the Action's step/);

    // A shard job of the same run that ran the Action and left no record still fails finish.
    await run(world, 601, 1, { command: () => `npx playwright test ${SELECT} --shard=1/2` });
    const after = await finishOf(world, 601);
    assert.ok(after.io.failed);
    assert.strictEqual(after.io.outputs['exactly-once'], 'failed');
  });

  test('a main step that refuses its inputs still leaves a start marker, so finish fails', async () => {
    requireFixture();
    const world = newWorld();
    const [job] = await run(world, 602, 1, { inputs: { 'publish-history': 'never' } });
    assert.match(job.main.error.message, /publish-history input must be auto or true/);
    const finish = await finishOf(world, 602);
    assert.ok(finish.io.failed);
    assert.strictEqual(finish.io.outputs['exactly-once'], 'failed');
    // A re-run whose inputs pass answers that marker once every shard has a later record.
    const rerun = [];
    for (const shard of [1, 2]) {
      rerun.push(
        await shardJob(
          { ws: workspace(), world },
          { runId: 602, attempt: 2, cwd: 'app', command: command(shard, 2) }
        )
      );
    }
    assert.ok(rerun.every((j) => j.main.error === null && j.user.status === 0));
    const recovered = await finishOf(world, 602, { env: { GITHUB_RUN_ATTEMPT: '2' } });
    assert.strictEqual(recovered.io.failed, null, recovered.io.summaryText);
    assert.strictEqual(recovered.io.outputs['exactly-once'], 'ok');
    // Re-running only the shard that refused its inputs answers its marker too, while the shard
    // that passed keeps its first record; without that re-run the run stays failed.
    const partial = newWorld();
    const shardOf = (shard, attempt, options = {}) =>
      shardJob(
        { ws: workspace(), world: partial },
        { runId: 604, attempt, cwd: 'app', command: command(shard, 2), ...options }
      );
    await shardOf(1, 1);
    await shardOf(2, 1, { inputs: { 'publish-history': 'never' } });
    assert.ok((await finishOf(partial, 604)).io.failed);
    await shardOf(2, 2);
    const healed = await finishOf(partial, 604, { env: { GITHUB_RUN_ATTEMPT: '2' } });
    assert.strictEqual(healed.io.failed, null, healed.io.summaryText);
  });

  test('a later attempt with no artifacts passes only while they cannot have expired', async () => {
    requireFixture();
    const world = newWorld();
    const runsApi = (days) => async () => ({
      ok: true,
      status: 200,
      json: async () => ({ created_at: new Date(Date.now() - days * 86400000).toISOString() }),
    });
    const attempt2 = (days, retention = '7') =>
      finishOf(world, 603, {
        inputs: { 'github-token': 't' },
        env: { GITHUB_RUN_ATTEMPT: '2', GITHUB_RETENTION_DAYS: retention },
        fetchImpl: runsApi(days),
      });
    const young = await attempt2(1);
    assert.strictEqual(young.io.failed, null, young.io.summaryText);
    assert.strictEqual(young.io.outputs['exactly-once'], 'not checked');
    const old = await attempt2(8);
    assert.ok(old.io.failed);
    assert.strictEqual(old.io.outputs['exactly-once'], 'failed');
    assert.match(old.io.summaryText, /cannot rule out that the artifacts of its run expired/);
    const unknown = await attempt2(1, '');
    assert.ok(unknown.io.failed, 'no retention to compare the age with');
  });
});

describe('history edge cases', () => {
  test('a damaged newest entry: native with a warning, and the shards publish over it', async () => {
    requireFixture();
    const world = newWorld();
    const [probe] = await run(world, 401, 1, { pnp: true });
    const key = probe.main.state.key;
    cacheSave(world, cacheKey(key, 1, 1), { 'history.json': Buffer.from('{"schema":') });
    const jobs = await run(world, 402, 2);
    assert.strictEqual(jobs[0].main.io.outputs.mode, 'native');
    assert.match(jobs[0].main.io.warnings.join('\n'), /history unusable/);
    assert.match(jobs[0].post.warnings.join('\n'), /not valid JSON.*published over it/);
    const healed = newest(world, key);
    assert.strictEqual(healed.key, cacheKey(key, 1, 3));
    assert.deepStrictEqual(parseHistory(healed.text).runs, [402]);
  });

  test('a fork pull request balances from the base history and publishes nothing', async () => {
    requireFixture();
    const world = newWorld();
    await run(world, 501, 2);
    const ws = workspace();
    const event = path.join(ws, 'event.json');
    fs.writeFileSync(
      event,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'someone/fork' } } } })
    );
    const before = newest(world, (await run(world, 502, 1, { pnp: true }))[0].main.state.key);
    const fork = await run(world, 503, 2, {
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_REF: 'refs/pull/1/merge',
      },
    });
    assert.strictEqual(fork[0].main.io.outputs.mode, 'balanced');
    assert.match(
      fork[0].post.lines.join('\n'),
      /history not published: pull request from someone\/fork/
    );
    assert.deepStrictEqual(newest(world, fork[0].main.state.key), before);
  });

  test('no Actions cache on the runner: native, the run recorded, nothing published', async () => {
    requireFixture();
    const world = newWorld();
    const jobs = await run(world, 601, 2, { cacheOptions: { available: false } });
    for (const job of jobs) {
      assert.strictEqual(
        job.main.io.outputs.reason,
        'the Actions cache is not available on this runner, so this shard runs native'
      );
      assert.strictEqual(job.user.status, 0, job.user.output);
    }
    assert.strictEqual(world.cache.size, 0);
    assert.strictEqual((await finishOf(world, 601)).io.failed, null);
  });

  test('a pull_request run that checks out the head sha: the pin follows the run, never the commit', async () => {
    requireFixture();
    const world = newWorld();
    await run(world, 701, 2);
    const ws = workspace();
    const event = path.join(ws, 'event.json');
    fs.writeFileSync(
      event,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'owner/repo' } } } })
    );
    // Each shard exports another GITHUB_SHA, as a workflow does that checks out the head commit.
    const jobs = [];
    for (const [shard, sha] of [
      [1, 'head1'],
      [2, 'head2'],
    ]) {
      const ctx = { ws: workspace(), world };
      jobs.push(
        await shardJob(ctx, {
          runId: 702,
          cwd: 'app',
          command: command(shard, 2),
          env: {
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: event,
            GITHUB_REF: 'refs/pull/7/merge',
            GITHUB_SHA: sha,
          },
        })
      );
    }
    assert.deepStrictEqual(
      jobs.map((j) => j.main.io.outputs.mode),
      ['balanced', 'balanced']
    );
    assert.strictEqual(planSha(jobs[0]), planSha(jobs[1]));
    for (const job of jobs) assert.strictEqual(job.user.status, 0, job.user.output);
    const finish = await finishOf(world, 702, { env: { GITHUB_SHA: 'merge' } });
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
  });

  test('each job and each run pins its own snapshot', () => {
    assert.notStrictEqual(pinKey('k', 'a', 1), pinKey('k', 'b', 1));
    assert.notStrictEqual(pinKey('k', 'a', 1), pinKey('k', 'a', 2));
  });

  test('a cache mode that refuses reads or writes: the shards cannot pin, so run native and publish nothing', async () => {
    requireFixture();
    const world = newWorld();
    await run(world, 801, 2);
    const before = [...world.cache.keys()].length;
    // Read-only: the history is there, but no save can decide a pin, so balancing could split
    // the shards over two snapshots.
    const jobs = await run(world, 802, 2, { cacheOptions: { writable: false } });
    for (const job of jobs) {
      assert.strictEqual(job.main.io.outputs.mode, 'native');
      assert.match(job.main.io.outputs.reason, /cache mode does not let it read and write/);
      assert.strictEqual(job.user.status, 0, job.user.output);
    }
    assert.match(jobs[0].post.lines.join('\n'), /cannot be read and written by this job/);
    assert.strictEqual([...world.cache.keys()].length, before);
    assert.strictEqual((await finishOf(world, 802)).io.failed, null);
    const none = await run(world, 803, 2, { cacheOptions: { readable: false } });
    assert.match(none[0].main.io.outputs.reason, /cache mode does not let it read/);
    // Write-only: a shard that cannot read the history publishes nothing over it.
    assert.match(none[0].post.lines.join('\n'), /cannot be read and written by this job/);
    assert.strictEqual([...world.cache.keys()].length, before);
  });
});

describe('a re-run of the whole workflow, which deletes the artifacts of the run', () => {
  const world = newWorld();
  let first;

  before(async () => {
    requireFixture();
    await run(world, 901, 2);
    first = await run(world, 902, 2);
  });

  test('every shard reads the pin of the first attempt, though the history moved on', async () => {
    assert.strictEqual(first[0].main.io.outputs.mode, 'balanced');
    rerunAll(world, 902);
    const again = await run(world, 902, 2, { attempt: 2 });
    for (const [i, job] of again.entries()) {
      assert.match(job.main.io.lines.join('\n'), /read the pin/);
      assert.strictEqual(
        job.main.io.exported.PSP_SNAPSHOT_SHA,
        first[i].main.io.exported.PSP_SNAPSHOT_SHA
      );
      assert.strictEqual(planSha(job), planSha(first[i]));
    }
    const finish = await finishOf(world, 902, { env: { GITHUB_RUN_ATTEMPT: '2' } });
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
    assert.strictEqual(finish.io.outputs['exactly-once'], 'ok');
  });

  test('with the pin evicted too, the shards of the re-run pin afresh, one snapshot for all', async () => {
    rerunAll(world, 902);
    world.cache.delete(pinKey(keyOf(first), 'test', 902));
    const again = await run(world, 902, 2, { attempt: 3, inputs: {} });
    const shas = again.map((job) => job.main.io.exported.PSP_SNAPSHOT_SHA);
    assert.strictEqual(new Set(shas).size, 1);
    assert.notStrictEqual(shas[0], first[0].main.io.exported.PSP_SNAPSHOT_SHA, 'a newer history');
    assert.strictEqual(planSha(again[0]), planSha(again[1]));
    const finish = await finishOf(world, 902, { env: { GITHUB_RUN_ATTEMPT: '3' } });
    assert.strictEqual(finish.io.failed, null, finish.io.summaryText);
  });
});
