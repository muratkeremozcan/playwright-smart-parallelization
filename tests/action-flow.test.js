/**
 * The whole Action as a consumer runs it: `action.yml` executed step by step by the local runner
 * model in support/composite.js, with real Playwright on a copy of the consumer fixture and a
 * modeled Actions cache and artifact store. These are the matrix rows of the plan: cold start,
 * warm run, a failed shard, rollback, a missing or repeated record, racing writers, a damaged
 * history, a fork pull request and a forged plan.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cacheRestore, cacheSave, newWorld, runAction } = require('./support/composite');
const { FIXTURE, requireFixture } = require('./support/fixture');
const { parseHistory, serializeHistory, emptyHistory } = require('../lib/history');
const { cachePrefix } = require('../lib/identity');
const { sha256 } = require('../lib/util');

const COMMAND = 'npx playwright test --project=chromium --grep-invert=oversized --reporter=dot';

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-ws-'));
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  for (const file of ['playwright.config.js', 'package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(FIXTURE, file), path.join(app, file));
  }
  fs.cpSync(path.join(FIXTURE, 'tests'), path.join(app, 'tests'), { recursive: true });
  fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  return ws;
}

const cloneWorld = (world) => ({
  cache: new Map(world.cache),
  created: world.created,
  artifacts: new Map(world.artifacts),
  log: [],
});

const envOf = (runId, extra = {}) => ({ GITHUB_RUN_ID: String(runId), ...extra });

function prepare(ctx, runId, inputs = {}, env = {}) {
  return runAction({
    inputs: {
      phase: 'prepare',
      shards: '2',
      'working-directory': 'app',
      command: COMMAND,
      ...inputs,
    },
    env: envOf(runId, env),
    world: ctx.world,
    workspace: ctx.ws,
  });
}

function shard(ctx, runId, plan, n, env = {}) {
  return runAction({
    inputs: { phase: 'run', plan, shard: String(n) },
    env: envOf(runId, env),
    world: ctx.world,
    workspace: ctx.ws,
  });
}

function finish(ctx, runId, plan, env = {}, hooks = {}) {
  return runAction({
    inputs: { phase: 'finish', plan },
    env: envOf(runId, env),
    world: ctx.world,
    workspace: ctx.ws,
    hooks,
  });
}

/** prepare, every shard, finish. */
function pipeline(ctx, runId, { inputs = {}, env = {} } = {}) {
  const p = prepare(ctx, runId, inputs);
  assert.strictEqual(p.outcome, 'success', p.stdout);
  const shards = [1, 2].map((n) => shard(ctx, runId, p.outputs.plan, n, env));
  const f = finish(ctx, runId, p.outputs.plan);
  return { prepare: p, shards, finish: f, plan: JSON.parse(p.outputs.plan) };
}

function newest(world, key) {
  const found = cacheRestore(world, cachePrefix(key), [cachePrefix(key)]);
  return found.entry
    ? { key: found.matched, text: found.entry.files['history.json'].toString() }
    : null;
}

const planLines = (out) => out.split('\n').filter((l) => /shard \d\/\d: balanced/.test(l));

describe('cold start, warm run, failed shard and rollback', () => {
  const ctx = {};
  let cold;
  let warm;

  before(() => {
    requireFixture();
    ctx.ws = workspace();
    ctx.world = newWorld();
    cold = pipeline(ctx, 101);
    warm = pipeline(ctx, 102);
  });

  test('cold: no history, every shard native, finish publishes the first history', () => {
    assert.strictEqual(cold.prepare.outputs.mode, 'native');
    assert.deepStrictEqual(JSON.parse(cold.prepare.outputs.matrix), { shard: [1, 2] });
    assert.deepStrictEqual(
      cold.shards.map((s) => s.outcome),
      ['success', 'success']
    );
    assert.deepStrictEqual(
      cold.shards.map((s) => planLines(s.stdout).length),
      [0, 0]
    );
    assert.strictEqual(cold.finish.outcome, 'success', cold.finish.stdout);
    assert.match(cold.finish.summary, /Playwright Smart Parallelization: ok/);
    // The warm run has published since; the first entry stays as cold start wrote it.
    const history = parseHistory(newestBefore(ctx, cold));
    assert.deepStrictEqual(history.runs, [101]);
    assert.strictEqual(history.source.fingerprint, cold.plan.fingerprint);
    assert.strictEqual(history.source.commit, 'c0ffee');
  });

  test('warm: balanced from that history, one plan line per shard with one plan sha', () => {
    assert.strictEqual(warm.prepare.outputs.mode, 'balanced');
    assert.strictEqual(warm.plan.sha, sha256(newestBefore(ctx, warm)));
    const lines = warm.shards.map((s) => planLines(s.stdout));
    assert.deepStrictEqual(
      lines.map((l) => l.length),
      [1, 1]
    );
    const shas = lines.map((l) => /plan ([0-9a-f]{12})/.exec(l[0])[1]);
    assert.strictEqual(shas[0], shas[1]);
    assert.strictEqual(warm.finish.outcome, 'success', warm.finish.stdout);
    assert.match(warm.finish.summary, /\| 1 \| 1 \| \d+ \| /);
    assert.ok(newest(ctx.world, warm.plan.key).key.endsWith('-2'));
  });

  test('a re-run of finish for a published run leaves the history as it was', () => {
    const before = newest(ctx.world, warm.plan.key);
    const again = finish(ctx, 102, warm.prepare.outputs.plan);
    assert.strictEqual(again.outcome, 'success');
    assert.match(again.stdout, /already in the history/);
    assert.deepStrictEqual(newest(ctx.world, warm.plan.key), before);
  });

  test('a failed shard: records uploaded, finish fails, history unchanged', () => {
    const before = newest(ctx.world, cold.plan.key);
    const failed = pipeline(ctx, 103, { env: { PSP_FIXTURE_FAIL: 'adds an item' } });
    assert.strictEqual(failed.plan.mode, 'balanced');
    assert.ok(failed.shards.some((s) => s.outcome === 'failure'));
    assert.strictEqual(
      [...ctx.world.artifacts.keys()].filter(
        (n) => n.startsWith('psp-record-') && n.includes('-103-')
      ).length,
      2
    );
    assert.strictEqual(failed.finish.outcome, 'failure');
    assert.match(failed.finish.summary, /ended with status failed/);
    assert.deepStrictEqual(newest(ctx.world, cold.plan.key), before);
  });

  test('rollback: a failed shard fails finish through its status record', () => {
    const off = pipeline(ctx, 105, {
      inputs: { enabled: 'false' },
      env: { PSP_FIXTURE_FAIL: 'adds an item' },
    });
    assert.ok(off.shards.some((s) => s.outcome === 'failure'));
    assert.strictEqual(off.finish.outcome, 'failure');
    assert.match(off.finish.summary, /shard \d exited with 1/);
  });

  test('rollback: enabled false runs plain --shard, no reporter, no plan line, no history write', () => {
    const before = newest(ctx.world, cold.plan.key);
    const off = pipeline(ctx, 104, { inputs: { enabled: 'false' } });
    assert.strictEqual(off.plan.mode, 'disabled');
    for (const s of off.shards) {
      assert.strictEqual(s.outcome, 'success');
      assert.doesNotMatch(s.stdout, /--add-reporter|plan [0-9a-f]{12}/);
    }
    const uploaded = [...ctx.world.artifacts].filter(([n]) => n.includes('-104-'));
    assert.strictEqual(uploaded.length, 2, 'one status record per shard');
    for (const [, files] of uploaded) {
      assert.strictEqual(
        JSON.parse(files['record.json'].toString()).schema,
        'playwright-smart-parallelization/status'
      );
    }
    assert.strictEqual(off.finish.outcome, 'success');
    assert.deepStrictEqual(newest(ctx.world, cold.plan.key), before);
  });
});

/** The first entry of the history: the one cold start published and the warm run pinned. */
function newestBefore(ctx, run) {
  return ctx.world.cache.get(`${cachePrefix(run.plan.key)}1`).files['history.json'].toString();
}

describe('finish against one recorded run', () => {
  const base = {};
  let plan;

  before(() => {
    requireFixture();
    base.ws = workspace();
    base.world = newWorld();
    const p = prepare(base, 201);
    plan = p.outputs.plan;
    for (const n of [1, 2]) assert.strictEqual(shard(base, 201, plan, n).outcome, 'success');
  });

  const fresh = () => ({ ws: base.ws, world: cloneWorld(base.world) });
  const key = () => JSON.parse(plan).key;
  const seed = (world, seq, runs) => {
    const history = { ...emptyHistory(key()), runs };
    history.tests[JSON.stringify(['chromium', 'seeded.spec.js', `run ${runs[0]}`])] = {
      samples: [[runs[0], 500]],
      seen: '2026-10-16',
    };
    cacheSave(world, `${cachePrefix(key())}${seq}`, {
      'history.json': Buffer.from(serializeHistory(history)),
    });
  };

  test('racing writers: the read-back differs, the loser saves the next key, both runs kept', () => {
    const ctx = fresh();
    seed(ctx.world, 1, [150]);
    const hooks = {
      before: (step, world) => {
        // Another writer saves the key this writer chose, between its read and its save.
        if (step.name === 'History, attempt 1, save') seed(world, 2, [160]);
      },
    };
    const f = finish(ctx, 201, plan, {}, hooks);
    assert.strictEqual(f.outcome, 'success', f.stdout);
    assert.match(f.stdout, /belongs to another writer/);
    const entry = newest(ctx.world, key());
    assert.ok(entry.key.endsWith('-3'), entry.key);
    assert.deepStrictEqual(parseHistory(entry.text).runs, [150, 160, 201]);
  });

  test('a key not readable yet: the next attempt tries the same key again', () => {
    const ctx = fresh();
    const hooks = {
      before: (step, world) => {
        if (step.name === 'History, attempt 1, read the key back')
          world.cache.delete(`${cachePrefix(key())}1`);
      },
    };
    const f = finish(ctx, 201, plan, {}, hooks);
    assert.strictEqual(f.outcome, 'success', f.stdout);
    assert.match(f.stdout, /not readable yet.*tried again/);
    assert.ok(newest(ctx.world, key()).key.endsWith('-1'));
    assert.deepStrictEqual(parseHistory(newest(ctx.world, key()).text).runs, [201]);
  });

  test('every attempt lost: finish fails loud and the history keeps its bytes', () => {
    const ctx = fresh();
    seed(ctx.world, 1, [150]);
    const before = newest(ctx.world, key());
    let competitor = 300;
    const hooks = {
      before: (step, world) => {
        const attempt = /^History, attempt (\d), save$/.exec(step.name);
        if (attempt) {
          const seqs = [...world.cache.keys()].map((k) => Number(k.split('-').pop()));
          seed(world, Math.max(...seqs) + 1, [competitor++]);
        }
      },
    };
    const f = finish(ctx, 201, plan, {}, hooks);
    assert.strictEqual(f.outcome, 'failure');
    assert.match(f.stdout, /no key won after 3 attempts/);
    for (const [name, entry] of ctx.world.cache) {
      if (name !== before.key)
        assert.ok(!parseHistory(entry.files['history.json'].toString()).runs.includes(201));
    }
  });

  test('a damaged newest entry: native for the run, finish heals it and fails once', () => {
    const ctx = fresh();
    cacheSave(ctx.world, `${cachePrefix(key())}1`, { 'history.json': Buffer.from('{"schema":') });
    const p = prepare(ctx, 201);
    assert.strictEqual(p.outputs.mode, 'native');
    assert.match(p.stdout, /::warning.*history unusable/);
    const f = finish(ctx, 201, p.outputs.plan);
    assert.strictEqual(f.outcome, 'failure');
    assert.match(f.stdout, /not valid JSON.*published over it/);
    const healed = newest(ctx.world, key());
    assert.ok(healed.key.endsWith('-2'));
    assert.deepStrictEqual(parseHistory(healed.text).runs, [201]);
    const next = prepare(ctx, 202);
    assert.strictEqual(next.outputs.mode, 'balanced');
    assert.strictEqual(JSON.parse(next.outputs.plan).seq, 2);
  });

  test('a fork pull request balances from the base history it can read', () => {
    const ctx = fresh();
    seed(ctx.world, 1, [150]);
    const event = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psp-event-')), 'event.json');
    fs.writeFileSync(
      event,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'someone/fork' } } } })
    );
    const p = prepare(
      ctx,
      201,
      {},
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event }
    );
    const pinned = JSON.parse(p.outputs.plan);
    assert.strictEqual(pinned.mode, 'balanced');
    const bytes = ctx.world.cache.get(`${cachePrefix(key())}1`).files['history.json'];
    assert.strictEqual(pinned.sha, sha256(bytes));
    assert.strictEqual(pinned.seq, 1);
  });

  test('the host job event never leaks into the model: a CI pull request still publishes here', () => {
    const ctx = fresh();
    const event = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psp-event-')), 'event.json');
    fs.writeFileSync(
      event,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'o/r' } } } })
    );
    const saved = { path: process.env.GITHUB_EVENT_PATH, name: process.env.GITHUB_EVENT_NAME };
    process.env.GITHUB_EVENT_PATH = event;
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    try {
      assert.strictEqual(finish(ctx, 201, plan).outcome, 'success');
      assert.ok(newest(ctx.world, key()));
    } finally {
      for (const [name, value] of [
        ['GITHUB_EVENT_PATH', saved.path],
        ['GITHUB_EVENT_NAME', saved.name],
      ]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('after a re-run of all jobs, a shard that never ran again fails finish', () => {
    const ctx = fresh();
    const again = prepare(ctx, 201, {}, { GITHUB_RUN_ATTEMPT: '2' });
    assert.strictEqual(JSON.parse(again.outputs.plan).attempt, 2);
    assert.strictEqual(
      shard(ctx, 201, again.outputs.plan, 2, { GITHUB_RUN_ATTEMPT: '2' }).outcome,
      'success'
    );
    const f = finish(ctx, 201, again.outputs.plan, { GITHUB_RUN_ATTEMPT: '2' });
    assert.strictEqual(f.outcome, 'failure');
    assert.match(f.summary, /no record for shard 1/);
  });

  test('a missing record fails finish before any history write', () => {
    const ctx = fresh();
    for (const name of [...ctx.world.artifacts.keys()]) {
      if (/psp-record-.*-2-attempt-1$/.test(name)) ctx.world.artifacts.delete(name);
    }
    const f = finish(ctx, 201, plan);
    assert.strictEqual(f.outcome, 'failure');
    assert.match(f.summary, /no record for shard 2/);
    assert.strictEqual(ctx.world.cache.size, 0);
  });

  test('a re-run shard: finish keeps the latest attempt of each shard', () => {
    const ctx = fresh();
    assert.strictEqual(shard(ctx, 201, plan, 2, { GITHUB_RUN_ATTEMPT: '2' }).outcome, 'success');
    const f = finish(ctx, 201, plan, { GITHUB_RUN_ATTEMPT: '2' });
    assert.strictEqual(f.outcome, 'success', f.stdout);
    assert.match(f.summary, /\| 2 \| 2 \| /);
  });

  test('a fork pull request reads history and publishes nothing', () => {
    const ctx = fresh();
    const event = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psp-event-')), 'event.json');
    fs.writeFileSync(
      event,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'someone/fork' } } } })
    );
    const f = finish(ctx, 201, plan, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event,
    });
    assert.strictEqual(f.outcome, 'success', f.stdout);
    assert.match(f.summary, /someone\/fork/);
    assert.strictEqual(ctx.world.cache.size, 0);
  });

  test('a forged plan is refused by run and finish', () => {
    const ctx = fresh();
    const forged = JSON.stringify({ ...JSON.parse(plan), historyKey: 'other' });
    assert.strictEqual(shard(ctx, 201, forged, 1).outcome, 'failure');
    const f = finish(ctx, 201, forged);
    assert.strictEqual(f.outcome, 'failure');
    assert.match(f.stdout, /plan key does not match/);
    assert.strictEqual(finish(ctx, 202, plan).outcome, 'failure', 'a plan of another run');
  });
});
