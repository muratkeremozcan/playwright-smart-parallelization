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
const { pin, pinText } = require('../lib/pin');
const { onDefaultBranch, trust } = require('../lib/trust');
const store = require('../lib/store');
const { toolkitCache } = require('../lib/cache');
const { fetchJobs, markdown, overheadFrom, simulate } = require('../lib/summary');
const { applyRun, emptyHistory, serializeHistory } = require('../lib/history');
const { cacheKey, cachePrefix, pinKey } = require('../lib/identity');
const { testKey } = require('../lib/plan/estimate');
const { mapLimit, sha256 } = require('../lib/util');
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
    assert.strictEqual(
      decide({ matchedKey: '', history: null, note: null }, key).reason,
      'no history yet'
    );
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

  test('the reporter is copied into a node_modules folder of the job temp, so Playwright loads it uncompiled', () => {
    const file = path.join(tmp('psp-'), 'reporter.js');
    fs.writeFileSync(file, 'module.exports = {};');
    const temp = tmp('psp-runner-temp-');
    const copy = reporterPath(file, temp);
    assert.ok(copy.startsWith(temp + path.sep), copy);
    assert.match(copy, /[\\/]node_modules[\\/]playwright-smart-parallelization[\\/]reporter\.js$/);
    assert.strictEqual(fs.readFileSync(copy, 'utf8'), 'module.exports = {};');
  });

  test('a job temp with whitespace in its path puts the copy under the system temp', () => {
    const dir = path.join(tmp('psp-'), 'with space');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'reporter.js');
    fs.writeFileSync(file, 'module.exports = {};');
    const copy = reporterPath(file, dir);
    assert.doesNotMatch(copy, /\s/);
    assert.ok(copy.startsWith(os.tmpdir()), copy);
    assert.strictEqual(fs.readFileSync(copy, 'utf8'), 'module.exports = {};');
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
        cache: modelCache(world, j.ws, opts.cacheOptions),
        artifacts: modelArtifacts(world, 7),
        sleep: async () => {},
        ...opts,
      });
    return { j, p, world, run };
  };
  const pinOf = (world, p) => world.cache.get(pinKey(p.key, 'test', 7));
  const seed = (world, p, seq, text) =>
    cacheSave(world, cacheKey(p.key, 1, seq), { 'history.json': Buffer.from(text) });
  const NONE = { matchedKey: '', history: null, note: null };

  test('the first shard pins the newest history; a later shard reads the pin, not a newer entry', async () => {
    const { p, world, run } = setupPin();
    const first = serializeHistory(someHistory(p.key));
    seed(world, p, 1, first);
    const a = await run();
    assert.deepStrictEqual(a, { matchedKey: cacheKey(p.key, 1, 1), history: first, note: null });
    assert.ok(pinOf(world, p));
    seed(world, p, 2, 'newer');
    assert.deepStrictEqual(await run(), a);
  });

  test('the shard whose save creates the pin plans from its own bytes, with no read of it after', async () => {
    const { p, world, run } = setupPin();
    seed(world, p, 1, serializeHistory(someHistory(p.key)));
    const reads = [];
    world.before = async (op, key) => {
      if (op === 'restore' && key.startsWith('psp-pin-')) reads.push(key);
    };
    const read = await run();
    assert.strictEqual(reads.length, 1, 'only the look before the save');
    assert.deepStrictEqual(await run(), read, 'a later shard reads the same bytes');
  });

  test('the newest history restores while the shard looks for the pin', async () => {
    const { p, world, run } = setupPin();
    seed(world, p, 1, serializeHistory(someHistory(p.key)));
    const order = [];
    world.before = async (op, key) => {
      const what = `${key.startsWith('psp-pin-') ? 'pin' : 'history'} ${op}`;
      order.push(`${what} starts`);
      if (what === 'pin restore')
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      order.push(`${what} answers`);
    };
    await run();
    assert.ok(
      order.indexOf('history restore starts') < order.indexOf('pin restore answers'),
      order.join(', ')
    );
  });

  test('no history is pinned too, so a shard that starts after a publish still plans native', async () => {
    const { p, world, run } = setupPin();
    assert.deepStrictEqual(await run(), NONE);
    seed(world, p, 1, serializeHistory(someHistory(p.key)));
    assert.deepStrictEqual(await run(), NONE);
  });

  test('a shard whose save lost waits for the winner and plans from its bytes; one never readable fails before any test', async () => {
    // Another shard reserves the pin between this shard's look and its save, and finishes
    // uploading it only once this shard has waited.
    const racing = (p, world, done) => {
      const key = pinKey(p.key, 'test', 7);
      const theirs = {
        files: {
          'pin.json': Buffer.from(
            pinText({
              key: p.key,
              runId: 7,
              job: 'test',
              matchedKey: '',
              history: null,
              note: 'theirs',
            })
          ),
        },
        created: 0,
        final: false,
      };
      world.before = async (op, k) => {
        if (k !== key) return;
        if (op === 'save' && !world.cache.has(key)) world.cache.set(key, theirs);
        if (op === 'restore' && world.cache.get(key) === theirs) theirs.final = done();
      };
    };
    const { p, world, run } = setupPin();
    seed(world, p, 1, serializeHistory(someHistory(p.key)));
    const waits = [];
    racing(p, world, () => waits.length > 0);
    const lines = [];
    const read = await run({ sleep: async (ms) => waits.push(ms), log: (l) => lines.push(l) });
    assert.deepStrictEqual(waits, [250]);
    assert.deepStrictEqual(read, { matchedKey: '', history: null, note: 'theirs' });
    assert.match(lines.join('\n'), /another shard pinned .* first/);
    const stuck = setupPin();
    racing(stuck.p, stuck.world, () => false);
    await assert.rejects(stuck.run(), /not readable after 30s, .* stops before any test/);
  });

  test('a save that failed for another reason than a lost race says so, and fails before any test', async () => {
    const { j, world, run } = setupPin();
    const cache = modelCache(world, j.ws);
    Object.assign(cache, {
      save: async () => {
        cache.saveFailed = true;
        return false;
      },
    });
    const lines = [];
    await assert.rejects(run({ cache, log: (l) => lines.push(l) }), /stops before any test/);
    assert.match(lines.join('\n'), /could not be saved; this shard plans from another shard's pin/);
  });

  test('a job that cannot read and write the cache cannot pin, so it runs unpinned', async () => {
    for (const [cacheOptions, reason] of [
      [{ available: false }, /not available on this runner/],
      [{ readable: false }, /cache mode does not let it read and write/],
      [{ writable: false }, /cache mode does not let it read and write/],
    ]) {
      const { world, run } = setupPin();
      const read = await run({ cacheOptions });
      assert.strictEqual(read.unpinned, true);
      assert.match(read.reason, reason);
      assert.strictEqual(world.cache.size, 0, 'nothing saved');
    }
  });

  test('a cache that refuses the save leaves the job unpinned, unless a pin is there', async () => {
    const { j, world, run } = setupPin();
    const denied = () => {
      const cache = modelCache(world, j.ws);
      return Object.assign(cache, {
        save: async () => {
          cache.writeDenied = true;
          return false;
        },
      });
    };
    assert.deepStrictEqual(await run({ cache: denied() }), {
      unpinned: true,
      reason: 'the Actions cache refuses writes for this job, so this shard runs native',
    });
    const a = await run();
    assert.deepStrictEqual(await run({ cache: denied() }), a);
  });

  test('a pin of another job or run is refused', async () => {
    const { p, world, run } = setupPin();
    cacheSave(world, pinKey(p.key, 'test', 7), {
      'pin.json': Buffer.from(
        pinText({ key: p.key, runId: 8, job: 'test', matchedKey: '', history: null })
      ),
    });
    await assert.rejects(run(), /not a pin of this job and run/);
  });

  describe('a re-run whose pin the cache evicted', () => {
    /** Uploads the record of `shard` of attempt `attempt`, with the pin it kept unless `pin` is false. */
    const record = async (world, p, { shard, attempt, mode, history = null, pin: keep = true }) => {
      const dir = tmp('psp-record-');
      fs.writeFileSync(
        path.join(dir, 'record.json'),
        JSON.stringify({
          schema: 'playwright-smart-parallelization/record',
          version: 1,
          run: { id: 7, attempt },
          key: p.key,
          job: 'test',
          shard: { current: shard, total: 2 },
          mode,
          snapshotSha: mode === 'balanced' ? sha256(history) : null,
          corpusSha: 'abc',
          corpus: null,
          tests: [],
        })
      );
      const files = [path.join(dir, 'record.json')];
      if (keep) {
        const matchedKey = history ? cacheKey(p.key, 1, 1) : '';
        fs.writeFileSync(
          path.join(dir, 'pin.json'),
          pinText({ key: p.key, runId: 7, job: 'test', matchedKey, history })
        );
        files.push(path.join(dir, 'pin.json'));
      }
      await modelArtifacts(world, 7).upload(
        `psp-record-test-${p.key.slice(0, 12)}-abc-${shard}of2-attempt-${attempt}`,
        files,
        dir
      );
    };

    test('plans from the bytes the kept shards planned from, though the history moved on', async () => {
      const { p, world, run } = setupPin();
      const kept = serializeHistory(someHistory(p.key));
      await record(world, p, { shard: 1, attempt: 1, mode: 'balanced', history: kept });
      seed(world, p, 1, kept);
      seed(world, p, 2, kept.replace('100', '101'));
      const lines = [];
      const read = await run({ attempt: 2, log: (l) => lines.push(l) });
      assert.deepStrictEqual(read, {
        matchedKey: cacheKey(p.key, 1, 1),
        history: kept,
        note: null,
      });
      assert.match(lines.join('\n'), /bytes the shards that already ran planned from/);
      assert.ok(pinOf(world, p), 'and pins them again');
    });

    test('runs native when the kept shards ran native', async () => {
      const { p, world, run } = setupPin();
      await record(world, p, { shard: 1, attempt: 1, mode: 'native', pin: false });
      seed(world, p, 1, serializeHistory(someHistory(p.key)));
      assert.deepStrictEqual(await run({ attempt: 2 }), {
        matchedKey: '',
        history: null,
        note: 'the shards of this run that already ran ran native',
      });
    });

    test('takes the newest attempt of each shard', async () => {
      const { p, world, run } = setupPin();
      const old = serializeHistory(someHistory(p.key));
      const kept = old.replace('100', '102');
      await record(world, p, { shard: 1, attempt: 1, mode: 'balanced', history: old });
      await record(world, p, { shard: 1, attempt: 2, mode: 'balanced', history: kept });
      await record(world, p, { shard: 2, attempt: 2, mode: 'balanced', history: kept });
      assert.strictEqual((await run({ attempt: 3 })).history, kept);
    });

    test('a shard of the first attempt that starts after the cache dropped the pin plans as the shards that already ran', async () => {
      const { p, world, run } = setupPin();
      const kept = serializeHistory(someHistory(p.key));
      await record(world, p, { shard: 1, attempt: 1, mode: 'balanced', history: kept });
      seed(world, p, 1, kept.replace('100', '101'));
      assert.strictEqual((await run({ attempt: 1 })).history, kept);
    });

    test('a shard that cannot pin runs native, unless the shards that already ran planned from a pin', async () => {
      const native = setupPin();
      await record(native.world, native.p, { shard: 1, attempt: 1, mode: 'native', pin: false });
      assert.strictEqual(
        (await native.run({ attempt: 2, cacheOptions: { available: false } })).unpinned,
        true
      );
      const { p, world, run } = setupPin();
      const kept = serializeHistory(someHistory(p.key));
      await record(world, p, { shard: 1, attempt: 1, mode: 'balanced', history: kept });
      await assert.rejects(
        run({ attempt: 2, cacheOptions: { writable: false } }),
        /cannot plan as they did; re-run it where the job can read and write the cache/
      );
    });

    test('fails before any test when the kept shards cannot all be matched', async () => {
      const { p, world, run } = setupPin();
      const kept = serializeHistory(someHistory(p.key));
      await record(world, p, { shard: 1, attempt: 1, mode: 'balanced', history: kept, pin: false });
      await assert.rejects(run({ attempt: 2 }), /no record .* holds its bytes.* start a new run/);
      await record(world, p, { shard: 2, attempt: 1, mode: 'native', pin: false });
      await assert.rejects(run({ attempt: 2 }), /different snapshots.* start a new run/);
    });

    test('with no record either, pins afresh only when no record can have expired', async () => {
      // A first attempt never looks back, and a re-run with no earlier record pins afresh.
      assert.deepStrictEqual(await setupPin().run({ attempt: 2, retentionDays: '90' }), NONE);
      // Artifacts kept shorter than a run can be re-run: a missing record may have expired.
      await assert.rejects(setupPin().run({ attempt: 2, retentionDays: '7' }), /kept 7 days/);
      await assert.rejects(
        setupPin().run({ attempt: 2, retentionDays: '7', runAge: async () => 9 }),
        /kept 7 days/
      );
      // A run younger than the retention has lost no artifact.
      assert.deepStrictEqual(
        await setupPin().run({ attempt: 2, retentionDays: '7', runAge: async () => 0.5 }),
        NONE
      );
      assert.ok(await setupPin().run({ attempt: 1, retentionDays: '7' }));
    });

    test('a server with no artifact service has no records to match', async () => {
      const artifacts = {
        list: async () => {
          throw Object.assign(new Error('no'), { name: 'GHESNotSupportedError' });
        },
      };
      assert.deepStrictEqual(
        await setupPin().run({ attempt: 2, retentionDays: '90', artifacts }),
        NONE
      );
    });
  });
});

test('a run is on the default branch only for a push or schedule of that branch', () => {
  const event = (payload) => {
    const file = path.join(tmp('psp-event-'), 'event.json');
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
  };
  const repo = { repository: { default_branch: 'main' } };
  const on = (env) => onDefaultBranch({ GITHUB_EVENT_NAME: 'push', ...env });
  assert.strictEqual(on({ GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: event(repo) }), true);
  assert.strictEqual(on({ GITHUB_REF: 'refs/heads/dev', GITHUB_EVENT_PATH: event(repo) }), false);
  assert.strictEqual(
    on({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_PATH: event({ ...repo, pull_request: {} }),
    }),
    false
  );
  assert.strictEqual(on({ GITHUB_REF: 'refs/heads/main' }), false, 'no payload');
  assert.strictEqual(
    on({ GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main' }),
    true,
    'a schedule runs on the default branch'
  );
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

test('mapLimit keeps the order of the items and never runs more than the limit at once', async () => {
  let running = 0;
  let most = 0;
  const results = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    most = Math.max(most, ++running);
    await new Promise((resolve) => setTimeout(resolve, n));
    running--;
    return n * 10;
  });
  assert.deepStrictEqual(results, [50, 10, 40, 20, 30]);
  assert.strictEqual(most, 2);
  await assert.rejects(
    mapLimit([1, 2], 4, async (n) => {
      if (n === 2) throw new Error('two');
    }),
    /two/
  );
  assert.deepStrictEqual(await mapLimit([], 4, async () => 1), []);
});

describe('the toolkit cache adapter', () => {
  /** Runs `fn` with stdout captured: `{ value, out }`. */
  async function captured(fn) {
    const write = process.stdout.write;
    let out = '';
    process.stdout.write = (chunk) => ((out += String(chunk)), true);
    try {
      return { value: await fn(), out };
    } finally {
      process.stdout.write = write;
    }
  }
  const saving = (id, lines) =>
    toolkitCache({
      saveCache: async () => {
        for (const line of lines) process.stdout.write(`${line}\n`);
        return id;
      },
    });

  test('a save that created the entry returns true', async () => {
    assert.strictEqual((await captured(() => saving(7, []).save('d', 'k'))).value, true);
  });

  test('a lost reservation returns false and logs plain lines, no warning annotation', async () => {
    const lines = [
      '::warning::Cache reservation failed: already exists',
      '::warning::Failed to save: Unable to reserve cache with key k, another job may be creating this cache.',
    ];
    const adapter = saving(-1, lines);
    const { value, out } = await captured(() => adapter.save('d', 'k'));
    assert.strictEqual(value, false);
    assert.strictEqual(adapter.saveFailed, false, 'another writer holds the key');
    assert.doesNotMatch(out, /::warning::/);
    assert.match(out, /^Failed to save: Unable to reserve cache with key k/m);
    // The cache service v2 logs its lost reservation as a plain line.
    const plain = saving(-1, [
      'Failed to save: Unable to reserve cache with key k, another job may be creating this cache.',
    ]);
    await captured(() => plain.save('d', 'k'));
    assert.strictEqual(plain.saveFailed, false);
  });

  test('an id with a logged failure, as the legacy service returns after a failed upload, did not create the entry', async () => {
    const adapter = saving(42, ['::warning::Failed to save: Cache upload failed']);
    const { value, out } = await captured(() => adapter.save('d', 'k'));
    assert.strictEqual(value, false);
    assert.strictEqual(adapter.saveFailed, true, 'no other writer holds the key');
    assert.match(
      out,
      /::warning::Failed to save: Cache upload failed/,
      'a real failure stays a warning'
    );
  });

  test('a write denied by policy is remembered', async () => {
    const adapter = saving(-1, ['::warning::Failed to save: cache write denied: read-only token']);
    await captured(() => adapter.save('d', 'k'));
    assert.strictEqual(adapter.writeDenied, true);
  });

  test('a lookup asks the toolkit for the key without its bytes', async () => {
    const calls = [];
    const adapter = toolkitCache({
      restoreCache: async (...args) => (calls.push(args), 'k-2'),
    });
    assert.strictEqual(await adapter.lookup('d', 'k-', ['k-']), 'k-2');
    assert.deepStrictEqual(calls, [[['d'], 'k-', ['k-'], { lookupOnly: true }]]);
  });
});

describe('the publish loop', () => {
  const key = 'kp';
  const runOf = (id) => ({
    id,
    attempt: 1,
    commit: 'c',
    fingerprint: 'f',
    date: '2026-10-16',
    samples: [[testKey('p', `s${id}.spec.js`, ['t']), id]],
  });
  const entry = (id) =>
    serializeHistory(
      applyRun(emptyHistory(key), { ...runOf(id), samples: new Map(runOf(id).samples) }).history
    );
  const seeded = () => {
    const world = newWorld();
    cacheSave(world, cacheKey(key, 20261016, 1), { 'history.json': Buffer.from(entry(1)) });
    return world;
  };
  const traced = (world) => {
    const ops = [];
    world.before = async (op, k) => ops.push(`${op} ${k.replace(cachePrefix(key), '')}`);
    return ops;
  };
  const publishOne = (world, id, options = {}) => {
    const ws = tmp('psp-writer-');
    const state = store.newState({ key, run: runOf(id), pinned: { epoch: 20261016, seq: 1 } });
    let pauses = 0;
    return store
      .publish(state, {
        cache: modelCache(world, ws),
        workspace: ws,
        sleep: async () => {},
        pause: () => (pauses++, 0),
        ...options,
      })
      .then((done) => ({ state: done, pauses }));
  };

  test('a writer that holds the newest entry reads only its key, and a save that creates the next key is not read back', async () => {
    const world = seeded();
    const ops = traced(world);
    const held = new Map([[cacheKey(key, 20261016, 1), entry(1)]]);
    const { state } = await publishOne(world, 2, { held });
    assert.strictEqual(state.status, 'published');
    assert.deepStrictEqual(ops, ['lookup ', 'save 20261016-2']);
    assert.deepStrictEqual(
      JSON.parse(world.cache.get(cacheKey(key, 20261016, 2)).files['history.json']).runs,
      [1, 2]
    );
  });

  test('off the default branch a writer holds no bytes, so it downloads the newest entry', async () => {
    // Another ref also reads the default branch's scope, where the same key can hold other bytes.
    const world = seeded();
    const ops = traced(world);
    const { state } = await publishOne(world, 2, { held: null });
    assert.strictEqual(state.status, 'published');
    assert.deepStrictEqual(ops, ['restore ', 'save 20261016-2']);
  });

  test('a writer that holds an older entry downloads the newest one', async () => {
    const world = seeded();
    cacheSave(world, cacheKey(key, 20261016, 2), { 'history.json': Buffer.from(entry(2)) });
    const ops = traced(world);
    const held = new Map([[cacheKey(key, 20261016, 1), entry(1)]]);
    const { state } = await publishOne(world, 3, { held });
    assert.strictEqual(state.status, 'published');
    assert.deepStrictEqual(ops, ['lookup ', 'restore 20261016-2', 'save 20261016-3']);
  });

  test('a lost key is read back, and the key after it is tried at once with no other read', async () => {
    const world = seeded();
    const ops = traced(world);
    const trace = world.before;
    world.before = async (op, k) => {
      await trace(op, k);
      // Another writer creates the key this one is about to save.
      if (op === 'save' && k === cacheKey(key, 20261016, 2)) {
        cacheSave(world, k, { 'history.json': Buffer.from(entry(9)) });
      }
    };
    const { state, pauses } = await publishOne(world, 2);
    assert.strictEqual(state.status, 'published');
    assert.strictEqual(pauses, 0);
    assert.deepStrictEqual(ops, [
      'restore ',
      'save 20261016-2',
      'restore 20261016-2',
      'save 20261016-3',
    ]);
    assert.deepStrictEqual(
      JSON.parse(world.cache.get(cacheKey(key, 20261016, 3)).files['history.json']).runs,
      [1, 2, 9]
    );
  });

  test('a key another writer is still uploading is paused for, then the newest is read again', async () => {
    const world = seeded();
    const ops = traced(world);
    const trace = world.before;
    let uploading = null;
    world.before = async (op, k) => {
      await trace(op, k);
      if (op === 'save' && k === cacheKey(key, 20261016, 2) && !uploading) {
        uploading = { files: { 'history.json': Buffer.from(entry(9)) }, created: ++world.created };
        world.cache.set(k, uploading);
      }
    };
    let paused = 0;
    const { state } = await publishOne(world, 2, {
      // The other writer finishes while this one pauses.
      pause: () => {
        paused++;
        uploading.final = true;
        return 0;
      },
    });
    assert.strictEqual(state.status, 'published');
    assert.strictEqual(paused, 1);
    assert.deepStrictEqual(ops, [
      'restore ',
      'save 20261016-2',
      'restore 20261016-2',
      'restore ',
      'save 20261016-3',
    ]);
    assert.deepStrictEqual(
      JSON.parse(world.cache.get(cacheKey(key, 20261016, 3)).files['history.json']).runs,
      [1, 2, 9]
    );
  });

  for (const warm of [false, true]) {
    const title = warm
      ? 'eight shards publishing at once onto the entry the pin holds: every sample lands once'
      : 'eight shards publishing at once: every sample lands once, in eight entries';
    test(title, async () => {
      const k8 = 'k8';
      const world = newWorld();
      // A warm run: the pin holds entry 1 of a run 499, and every writer holds its bytes.
      const pinned = warm ? cacheKey(k8, 20261016, 1) : null;
      const base = serializeHistory(
        applyRun(emptyHistory(k8), {
          ...runOf(499),
          samples: new Map([[testKey('p', 'base.spec.js', ['t']), 50]]),
        }).history
      );
      if (warm) cacheSave(world, pinned, { 'history.json': Buffer.from(base) });
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
            key: k8,
            attempts: store.attemptsFor(8),
            pinned: warm ? { epoch: 20261016, seq: 1 } : null,
            run: {
              ...runOf(500),
              samples: [[testKey('p', `s${shard}.spec.js`, ['t']), 100 * shard]],
            },
          });
          return store.publish(state, {
            cache: modelCache(world, ws),
            workspace: ws,
            sleep: async () => {},
            pause: () => 0,
            held: warm ? new Map([[pinned, base]]) : new Map(),
          });
        })
      );
      assert.deepStrictEqual(
        states.map((s) => s.status),
        shards.map(() => 'published')
      );
      const newest = [...world.cache]
        .filter(([k]) => k.startsWith(cachePrefix(k8)))
        .sort((a, b) => b[1].created - a[1].created)[0];
      assert.strictEqual(newest[0], cacheKey(k8, 20261016, warm ? 9 : 8));
      const history = JSON.parse(newest[1].files['history.json'].toString());
      assert.deepStrictEqual(history.runs, warm ? [499, 500] : [500]);
      assert.deepStrictEqual(
        Object.values(history.tests)
          .map((t) => t.samples)
          .filter(([[id]]) => id === 500),
        shards.map((s) => [[500, 100 * s]])
      );
      assert.ok(
        states.some((s) => s.attempted.length > 1),
        'the writers raced'
      );
    });
  }
});
