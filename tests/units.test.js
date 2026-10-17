/**
 * The modules in isolation: the inputs and the history key, the mode decision of the main step,
 * the pin, the trust rule, the compare-and-swap of the store and the summary.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { actionInputs, readInputs, ACTION_INPUTS } = require('../lib/inputs');
const { decide, preliminary, reporterPath, runAgeDays } = require('../lib/setup');
const { pin } = require('../lib/pin');
const { trust } = require('../lib/trust');
const store = require('../lib/store');
const { fetchJobs, markdown, overheadFrom, simulate } = require('../lib/summary');
const { applyRun, emptyHistory, serializeHistory } = require('../lib/history');
const { cacheKey, cachePrefix, pinName } = require('../lib/identity');
const { testKey } = require('../lib/plan/estimate');
const { sha256 } = require('../lib/util');
const { FIXTURE } = require('./support/fixture');
const { modelArtifacts, modelCache, newWorld, cacheSave } = require('./support/model');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A workspace with a lockfile under `app` (the fixture's, or one of `version`), and its env. */
function job({ version = null, at = 'app' } = {}) {
  const ws = tmp('psp-unit-');
  const app = path.join(ws, at);
  fs.mkdirSync(app, { recursive: true });
  const lock = version
    ? JSON.stringify({ packages: { 'node_modules/@playwright/test': { version } } })
    : fs.readFileSync(path.join(FIXTURE, 'package-lock.json'), 'utf8');
  fs.writeFileSync(path.join(app, 'package.json'), '{}');
  fs.writeFileSync(path.join(app, 'package-lock.json'), lock);
  return {
    ws,
    app,
    env: { GITHUB_WORKSPACE: ws, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' },
  };
}

const prepared = (j, inputs = {}) =>
  actionInputs({ ...readInputs(ACTION_INPUTS, {}), 'working-directory': 'app', ...inputs }, j.env);

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
  test('the history key changes with the working directory, workers, runner label and history-key', () => {
    const j = job();
    fs.mkdirSync(path.join(j.ws, 'other'));
    const base = prepared(j).key;
    assert.notStrictEqual(prepared(j, { workers: '2' }).key, base);
    assert.notStrictEqual(prepared(j, { 'runner-label': 'big' }).key, base);
    assert.notStrictEqual(prepared(j, { 'history-key': 'staging' }).key, base);
    assert.notStrictEqual(prepared(j, { 'working-directory': 'other' }).key, base);
    assert.strictEqual(prepared(j, { enabled: 'false' }).key, base);
  });

  test('refuses bad workers, enabled, publish-history and a directory outside the workspace', () => {
    const j = job();
    assert.throws(() => prepared(j, { workers: '0' }), /workers input must be a whole number/);
    assert.throws(() => prepared(j, { enabled: 'yes' }), /enabled input must be true or false/);
    assert.throws(() => prepared(j, { 'publish-history': 'x' }), /publish-history input/);
    assert.throws(() => prepared(j, { 'working-directory': '..' }), /outside the workspace/);
    assert.throws(() => prepared(j, { 'working-directory': 'nope' }), /does not exist/);
  });

  test('reads the inputs the runner passes as INPUT_<NAME>', () => {
    assert.deepStrictEqual(readInputs(['history-key'], { 'INPUT_HISTORY-KEY': ' a ' }), {
      'history-key': 'a',
    });
  });
});

describe('the main step decides the mode of its shard', () => {
  test('enabled false, Playwright 1.62, no Playwright and Plug and Play: disabled', () => {
    assert.match(
      preliminary(prepared(job(), { enabled: 'false' })).reason,
      /enabled input is false/
    );
    assert.match(
      preliminary(prepared(job({ version: '1.62.0' }))).reason,
      /1\.62\.0 in app is below 1\.63\.0/
    );
    assert.strictEqual(preliminary(prepared(job({ version: '1.63.0' }))), null);
    const none = job();
    fs.rmSync(path.join(none.app, 'package-lock.json'));
    assert.match(preliminary(prepared(none)).reason, /no Playwright version found/);
    const pnp = job();
    fs.writeFileSync(path.join(pnp.ws, '.pnp.cjs'), '');
    assert.match(preliminary(prepared(pnp)).reason, /Plug'n'Play/);
  });

  test('a project in a subdirectory is found without working-directory', () => {
    const j = job({ at: 'packages/e2e' });
    const top = actionInputs(readInputs(ACTION_INPUTS, {}), j.env);
    assert.strictEqual(preliminary(top), null);
    const old = job({ version: '1.60.0', at: 'packages/e2e' });
    assert.match(
      preliminary(actionInputs(readInputs(ACTION_INPUTS, {}), old.env)).reason,
      /1\.60\.0 in packages\/e2e is below/
    );
  });

  test('the pinned bytes decide: none or damaged is native, a valid history is balanced', () => {
    const key = 'k';
    const text = serializeHistory(someHistory(key));
    const matched = cacheKey(key, 3, 4);
    assert.strictEqual(decide({ matchedKey: '', history: null }, key).reason, 'no history yet');
    const balanced = decide({ matchedKey: matched, history: text }, key);
    assert.deepStrictEqual(
      [balanced.mode, balanced.sha, balanced.slot],
      ['balanced', sha256(text), { epoch: 3, seq: 4 }]
    );
    const damaged = decide({ matchedKey: matched, history: '{' }, key);
    assert.deepStrictEqual(
      [damaged.mode, damaged.damaged, damaged.slot],
      ['native', true, { epoch: 3, seq: 4 }]
    );
    assert.match(
      decide({ matchedKey: matched, history: serializeHistory(emptyHistory(key)) }, key).reason,
      /has no entries/
    );
    assert.match(
      decide({ matchedKey: 'psp-other', history: text }, key).reason,
      /not a history entry of this key/
    );
    assert.strictEqual(decide({ unpinned: true, reason: 'no cache' }, key).mode, 'native');
  });

  test('a reporter path with whitespace is copied to one without', () => {
    const dir = path.join(tmp('psp-'), 'with space');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'reporter.js');
    fs.writeFileSync(file, 'module.exports = {};');
    const copy = reporterPath(file);
    assert.doesNotMatch(copy, /\s/);
    assert.strictEqual(fs.readFileSync(copy, 'utf8'), 'module.exports = {};');
    assert.strictEqual(reporterPath(path.join(tmp('psp-'), 'r.js')).includes(' '), false);
  });
});

test('the run age comes from the runs API, and is unknown when it cannot be read', async () => {
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };
  const created = new Date(Date.now() - 2 * 86400000).toISOString();
  const age = await runAgeDays(
    env,
    async () => ({ ok: true, json: async () => ({ created_at: created }) }),
    't'
  );
  assert.ok(age > 1.9 && age < 2.1);
  assert.strictEqual(await runAgeDays(env, async () => ({ ok: false, status: 403 }), 't'), null);
  assert.strictEqual(await runAgeDays(env, async () => ({}), ''), null);
});

describe('the pin', () => {
  const setupPin = () => {
    const j = job();
    const p = prepared(j);
    const world = newWorld();
    const run = (opts = {}) =>
      pin({
        prepared: p,
        runId: 7,
        job: 'test',
        cache: modelCache(world, j.ws),
        artifacts: modelArtifacts(world, 7),
        sleep: async () => {},
        ...opts,
      });
    return { j, p, world, run };
  };
  const pinArtifact = (world, p) => world.runs.get('7').get(pinName(p.key, 'test'));

  test('the first shard pins the newest history; a later shard reads the pin, not a newer entry', async () => {
    const { p, world, run } = setupPin();
    const first = serializeHistory(someHistory(p.key));
    cacheSave(world, cacheKey(p.key, 1, 1), { 'history.json': Buffer.from(first) });
    const a = await run();
    assert.deepStrictEqual(a, { matchedKey: cacheKey(p.key, 1, 1), history: first });
    assert.ok(pinArtifact(world, p));
    cacheSave(world, cacheKey(p.key, 1, 2), { 'history.json': Buffer.from('newer') });
    assert.deepStrictEqual(await run(), a);
  });

  test('a re-run after the cache evicted every entry still reads the pin', async () => {
    const { p, world, run } = setupPin();
    const first = serializeHistory(someHistory(p.key));
    cacheSave(world, cacheKey(p.key, 1, 1), { 'history.json': Buffer.from(first) });
    const a = await run();
    world.cache.clear();
    assert.deepStrictEqual(await run(), a);
  });

  test('a re-run whose pin expired matches unpinned earlier shards and stops after pinned ones', async () => {
    const { p, world, run } = setupPin();
    const record = async (pinned, n) => {
      const dir = tmp('psp-record-');
      fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ pinned }));
      await modelArtifacts(world, 7).upload(
        `psp-record-test-${p.key.slice(0, 12)}-abc-${n}of2-attempt-1`,
        [path.join(dir, 'record.json')],
        dir
      );
    };
    await record(false, 1);
    assert.deepStrictEqual(await run({ attempt: 2 }), {
      unpinned: true,
      reason: 'the earlier attempt of this run ran unpinned, so this re-run does too',
    });
    await record(true, 2);
    await assert.rejects(run({ attempt: 2 }), /is gone .* start a new run/);
    // A first attempt never looks back, and a re-run with no earlier shard pins afresh.
    const fresh = setupPin();
    assert.deepStrictEqual(await fresh.run({ attempt: 2, retentionDays: '90' }), {
      matchedKey: '',
      history: null,
    });
    // Artifacts kept shorter than a run can be re-run: a missing pin may have expired.
    await assert.rejects(setupPin().run({ attempt: 2, retentionDays: '7' }), /kept 7 days/);
    await assert.rejects(
      setupPin().run({ attempt: 2, retentionDays: '7', runAge: async () => 9 }),
      /kept 7 days/
    );
    // A run younger than the retention has lost no artifact: no shard ever pinned.
    assert.deepStrictEqual(
      await setupPin().run({ attempt: 2, retentionDays: '7', runAge: async () => 0.5 }),
      { matchedKey: '', history: null }
    );
    assert.ok(await setupPin().run({ attempt: 1, retentionDays: '7' }));
  });

  test('no history is pinned too, so a shard that starts after a publish still plans native', async () => {
    const { p, world, run } = setupPin();
    assert.deepStrictEqual(await run(), { matchedKey: '', history: null });
    cacheSave(world, cacheKey(p.key, 1, 1), {
      'history.json': Buffer.from(serializeHistory(someHistory(p.key))),
    });
    assert.deepStrictEqual(await run(), { matchedKey: '', history: null });
  });

  test('two shards racing for the pin plan from the winner, even when the history moved between them', async () => {
    const { j, p, world } = setupPin();
    cacheSave(world, cacheKey(p.key, 1, 1), {
      'history.json': Buffer.from(serializeHistory(someHistory(p.key))),
    });
    const other = tmp('psp-unit-');
    let moved = false;
    world.before = async (op) => {
      // After the first history read, another run publishes a newer entry.
      if (op === 'upload' && !moved) {
        moved = true;
        cacheSave(world, cacheKey(p.key, 1, 2), {
          'history.json': Buffer.from(serializeHistory(someHistory(p.key)).replace('100', '101')),
        });
      }
    };
    const results = await Promise.all(
      [j.ws, other].map((ws) =>
        pin({
          prepared: { ...p, workspace: ws },
          runId: 7,
          job: 'test',
          cache: modelCache(world, ws),
          artifacts: modelArtifacts(world, 7),
          // A wait lets time pass, so the winner's upload completes.
          sleep: () => new Promise((resolve) => setImmediate(resolve)),
        })
      )
    );
    assert.deepStrictEqual(results[0], results[1]);
  });

  test('a pin still uploading is waited for; one never readable fails the shard before any test', async () => {
    const { p, world, run } = setupPin();
    const waits = [];
    let uploading = true;
    world.before = async (op) => {
      // The pin stays mid-upload until the shard has waited once.
      const artifact = op === 'find' && world.runs.get('7').get(pinName(p.key, 'test'));
      if (artifact) artifact.final = !uploading;
    };
    await run({
      sleep: async (ms) => {
        waits.push(ms);
        uploading = false;
      },
    });
    assert.deepStrictEqual(waits, [1000]);
    const stuck = setupPin();
    stuck.world.before = async (op) => {
      const artifact = op === 'find' && stuck.world.runs.get('7').get(pinName(stuck.p.key, 'test'));
      if (artifact) artifact.final = false;
    };
    await assert.rejects(stuck.run(), /was not found after 30s.*stops before any test/);
  });

  test('a server with no artifact service leaves every shard unpinned', async () => {
    const { run } = setupPin();
    const artifacts = {
      find: async () => {
        throw Object.assign(new Error('no'), { name: 'GHESNotSupportedError' });
      },
    };
    assert.deepStrictEqual(await run({ artifacts }), {
      unpinned: true,
      reason: 'this server has no artifact service to pin a snapshot in',
    });
  });

  test('a pin of another job or run is refused', async () => {
    const { p, world, run } = setupPin();
    const dir = tmp('psp-pin-');
    fs.writeFileSync(
      path.join(dir, 'pin.json'),
      JSON.stringify({
        schema: 'playwright-smart-parallelization/pin',
        version: 1,
        key: p.key,
        runId: 8,
        job: 'test',
        matchedKey: '',
        history: null,
      })
    );
    await modelArtifacts(world, 7).upload(
      pinName(p.key, 'test'),
      [path.join(dir, 'pin.json')],
      dir
    );
    await assert.rejects(run(), /not a pin of this job and run/);
  });
});

describe('publish-history', () => {
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
    const trusted = (env, mode) => trust(env, mode).trusted;
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

  test('a cold history starts a chain under the date of the write and verifies it', () => {
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

  test('a history that holds these samples already saves nothing', () => {
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

  test('the next key continues the epoch read and is above the entry the pin holds', () => {
    const state = store.newState({ key, run: runOf(7), pinned: slot(4, 6) });
    assert.strictEqual(
      store.write(state, { matchedKey: cacheKey(key, 4, 2), text: entry(1) }).key,
      cacheKey(key, 4, 7)
    );
  });

  test('higher keys of an older day never block a fresh chain: it publishes on its first attempt', () => {
    // An old chain 20261015-2..4 survives an eviction the cache hides; the pin and the shard see nothing.
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

  test('a prefix read that misses while the pin holds an entry publishes nothing', () => {
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
      Array.from({ length: store.ATTEMPTS }, () => slot(20261016, 1)),
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
    const text = markdown({ title: 'Suite', plan, check: { ok: true, problems: [], records } });
    assert.match(text, /^### Suite: ok/);
    assert.match(text, /\| 1 \| 1 \| 3 \| 3\.0s \| 4\.0s \| 3\.8s \| passed \|/);
    assert.match(text, /\| 2 \| 1 \| 3 \| 3\.5s \| 6\.0s \| 5\.9s \| passed \|/);
    assert.match(
      text,
      /Slowest shard 2 at 6\.0s, spread 2\.0s, imbalance 20\.0% \(slowest over the mean\)\./
    );
    assert.match(text, /Plan `bbbbbbbbbbbb`\./);
  });

  test('reads the jobs API and reports why it could not', async () => {
    const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' };
    const ok = await fetchJobs(
      env,
      async () => ({ ok: true, json: async () => ({ jobs: [{ id: 1 }] }) }),
      't'
    );
    assert.deepStrictEqual(ok, { jobs: [{ id: 1 }] });
    const denied = await fetchJobs(env, async () => ({ ok: false, status: 403 }), 't');
    assert.match(denied.error, /403: give the finish job `permissions: actions: read`/);
    const missing = await fetchJobs(
      { ...env, GITHUB_API_URL: 'https://ghe.example/api/v3' },
      async () => ({ ok: false, status: 404 }),
      't'
    );
    assert.match(missing.error, /404 for run 1 at https:\/\/ghe\.example\/api\/v3/);
    assert.match(missing.error, /permissions: actions: read/);
    const broken = await fetchJobs(env, async () => ({ ok: false, status: 500 }), 't');
    assert.doesNotMatch(broken.error, /actions: read/);
    assert.match((await fetchJobs({}, async () => ({}))).error, /no token/);
  });
});

describe('the publish loop', () => {
  test('eight shards publishing at once: every sample lands once, in eight entries', async () => {
    const key = 'k8';
    const world = newWorld();
    // Each writer yields at every cache call in a seeded order, so the attempts interleave.
    let seed = 7;
    world.before = async () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      for (let i = seed % 4; i > 0; i--) await new Promise((r) => setImmediate(r));
    };
    const shards = Array.from({ length: 8 }, (_, i) => i + 1);
    const states = await Promise.all(
      shards.map((shard) => {
        const ws = tmp('psp-writer-');
        const state = store.newState({
          key,
          attempts: store.attemptsFor(8),
          run: {
            id: 500,
            attempt: 1,
            commit: 'c',
            fingerprint: 'f',
            date: '2026-10-16',
            samples: [[testKey('p', `s${shard}.spec.js`, ['t']), 100 * shard]],
          },
        });
        return store.publish(state, {
          cache: modelCache(world, ws),
          workspace: ws,
          sleep: async () => {},
          pause: () => 0,
        });
      })
    );
    assert.deepStrictEqual(
      states.map((s) => s.status),
      shards.map(() => 'published')
    );
    const newest = [...world.cache]
      .filter(([k]) => k.startsWith(cachePrefix(key)))
      .sort((a, b) => b[1].created - a[1].created)[0];
    assert.strictEqual(newest[0], cacheKey(key, 20261016, 8));
    const history = JSON.parse(newest[1].files['history.json'].toString());
    assert.deepStrictEqual(history.runs, [500]);
    assert.deepStrictEqual(
      Object.values(history.tests).map((t) => t.samples),
      shards.map((s) => [[500, 100 * s]])
    );
    assert.ok(
      states.some((s) => s.attempted.length > 1),
      'the writers raced'
    );
  });
});
