/**
 * Lifecycle under balancing, on the browser-free lifecycle fixture (two projects, --repeat-each 2,
 * two workers per shard): worker-scoped fixtures set up and clean up once per worker process, a
 * default suite's beforeAll and afterAll pair up wherever the suite runs, a failure replaces its
 * worker, and a serial group retries with its cleanup. A native run with the reporter and a
 * balanced run from its history must both hold these relationships and run the same attempts with
 * the same results. Which worker runs which test is not compared: Playwright does not promise it.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  actionPartition,
  checkRun,
  planOf,
  publish,
  readRecords,
  runQualified,
  tempDir,
  writeSnapshot,
} = require('./support/action');
const { requireFixture } = require('./support/fixture');

const OPTIONS = { config: 'lifecycle.config.js', repeatEach: 2, workers: 2 };

function lifecycleRun(mode, snapshot = null) {
  const recordDir = tempDir('psp-records-');
  const log = path.join(tempDir('psp-lifecycle-'), 'events.jsonl');
  const partition = actionPartition({ total: 2, mode, snapshot, recordDir, workers: 2 }).map(
    (shard, i) => ({
      ...shard,
      env: { ...shard.env, PSP_LIFECYCLE_LOG: log, PSP_LIFECYCLE_SHARD: String(i + 1) },
    })
  );
  const run = runQualified(OPTIONS, partition);
  const events = fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...run, events, records: readRecords(recordDir) };
}

const count = (items, keyOf) => {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) || 0) + 1);
  return counts;
};

function assertLifecycle(run) {
  assert.deepStrictEqual(run.violations, []);
  const { events } = run;
  // One setup and one cleanup per worker process.
  const setups = count(
    events.filter((e) => e.type === 'worker-setup'),
    (e) => `${e.shard}:${e.pid}`
  );
  const cleanups = count(
    events.filter((e) => e.type === 'worker-cleanup'),
    (e) => `${e.shard}:${e.pid}`
  );
  assert.ok(setups.size > 0);
  assert.deepStrictEqual([...setups.entries()].sort(), [...cleanups.entries()].sort());
  assert.ok([...setups.values()].every((n) => n === 1));
  // Every beforeAll of the shared suite has its afterAll in the same worker.
  const hookKey = (e) => `${e.shard}:${e.pid}:${e.project}:${e.repeat}`;
  const befores = count(
    events.filter((e) => e.type === 'before-all'),
    hookKey
  );
  const afters = count(
    events.filter((e) => e.type === 'after-all'),
    hookKey
  );
  assert.deepStrictEqual([...befores.entries()].sort(), [...afters.entries()].sort());
  // The failed first attempt replaces its worker, whose cleanup still runs.
  for (const project of ['alpha', 'beta']) {
    for (const repeat of [0, 1]) {
      const attempts = events.filter(
        (e) =>
          e.type === 'test' &&
          e.title === 'fails once and passes in a new worker' &&
          e.project === project &&
          e.repeat === repeat
      );
      assert.deepStrictEqual(attempts.map((e) => e.retry).sort(), [0, 1]);
      const [first, second] = [0, 1].map((r) => attempts.find((e) => e.retry === r));
      assert.notStrictEqual(first.pid, second.pid, 'the retry runs in a new worker');
      assert.ok(events.some((e) => e.type === 'worker-cleanup' && e.pid === first.pid));
      // The serial group retries whole, with its cleanup after each attempt.
      const cleanups = events.filter(
        (e) => e.type === 'serial-cleanup' && e.project === project && e.repeat === repeat
      );
      assert.deepStrictEqual(cleanups.map((e) => e.retry).sort(), [0, 1]);
    }
  }
}

const attemptsOf = (events) =>
  events
    .filter((e) => e.type === 'test')
    .map((e) => `${e.project}|${e.file}|${e.title}|${e.repeat}|${e.retry}|${e.status}`)
    .sort();

const suitesWithHooks = (events) =>
  [
    ...new Set(
      events.filter((e) => e.type === 'before-all').map((e) => `${e.project}|${e.repeat}`)
    ),
  ].sort();

describe('lifecycle, native and balanced', () => {
  let native;
  let balanced;
  let snapshot;

  before(() => {
    requireFixture();
    native = lifecycleRun('native');
    snapshot = writeSnapshot(publish(native.records));
    balanced = lifecycleRun('balanced', snapshot);
  });

  test('native: worker, hook, replacement and serial-retry lifecycle holds', () => {
    assertLifecycle(native);
    assert.ok(checkRun(planOf({ mode: 'native', total: 2 }), native.records).ok);
  });

  test('balanced: the same relationships hold', () => {
    assertLifecycle(balanced);
    const result = checkRun(
      planOf({ mode: 'balanced', total: 2, sha: snapshot.sha }),
      balanced.records
    );
    assert.deepStrictEqual(result.problems, []);
  });

  test('both runs make the same attempts with the same results and open the same suites', () => {
    assert.deepStrictEqual(attemptsOf(balanced.events), attemptsOf(native.events));
    assert.deepStrictEqual(suitesWithHooks(balanced.events), suitesWithHooks(native.events));
  });

  test('the history samples the passing attempt of a test that failed first', () => {
    const records = native.records;
    const flaky = records
      .flatMap((r) => r.tests)
      .filter((t) => JSON.parse(t.key).includes('fails once and passes in a new worker'));
    assert.ok(flaky.length > 0);
    for (const t of flaky) {
      assert.strictEqual(t.outcome, 'flaky');
      assert.ok(t.sample_ms > 0 && t.sample_ms < 1000, `sample ${t.sample_ms}`);
    }
  });
});
