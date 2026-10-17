/**
 * The Action's reporter on the consumer fixture, through the harness: a native run with the
 * reporter records the run and publishes the first history, and balanced runs from that history
 * cover every leaf once, keep serial groups and setup dependencies, log one plan sha on every
 * shard and pass the finish check. Every run here is real Playwright.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const {
  actionPartition,
  checkRun,
  planLines,
  planOf,
  planShaOf,
  publish,
  readRecords,
  runQualified,
  tempDir,
  writeSnapshot,
  REPORTER,
} = require('./support/action');
const { FIXTURE, requireFixture } = require('./support/fixture');
const { nativePartition } = require('../harness/partitions');

// The oversized serial file sleeps for nine seconds and adds nothing these tests need.
const FORWARD = ['--grep-invert=oversized'];

let native;
let history;

before(() => {
  requireFixture();
  const recordDir = tempDir('psp-records-');
  const run = runQualified(
    { forward: FORWARD, workers: 1 },
    actionPartition({ total: 3, mode: 'native', recordDir })
  );
  native = { ...run, records: readRecords(recordDir) };
  history = publish(native.records);
});

describe('native mode with the reporter', () => {
  test('keeps Playwright split, covers every leaf once and passes the check', () => {
    assert.deepStrictEqual(native.violations, []);
    assert.strictEqual(native.records.length, 3);
    const result = checkRun(planOf({ mode: 'native', total: 3 }), native.records);
    assert.deepStrictEqual(result.problems, []);
    assert.ok(result.ok);
  });

  test('leaves every shard with the leaves a run without the Action has', () => {
    const plain = runQualified({ forward: FORWARD, workers: 1 }, nativePartition(3));
    assert.deepStrictEqual(plain.violations, []);
    const keys = (shards) => shards.map((s) => s.leaves.map((l) => l.key).sort());
    assert.deepStrictEqual(keys(native.shards), keys(plain.shards));
  });

  test('the first history holds one sample per test, setup included once', () => {
    const keys = Object.keys(history.tests);
    assert.ok(keys.length > 40, `${keys.length} entries`);
    const setup = keys.filter((k) => JSON.parse(k)[0] === 'setup');
    assert.strictEqual(setup.length, 1);
    assert.strictEqual(history.tests[setup[0]].samples.length, 1);
    assert.deepStrictEqual(history.runs, [101]);
  });
});

describe('balanced mode from the history', () => {
  let snapshot;
  let balanced;

  before(() => {
    snapshot = writeSnapshot(history);
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { forward: FORWARD, workers: 1 },
      actionPartition({ total: 3, mode: 'balanced', snapshot, recordDir, runId: 102 })
    );
    balanced = { ...run, records: readRecords(recordDir) };
  });

  test('covers every leaf once with serial groups and setup dependencies intact', () => {
    assert.deepStrictEqual(balanced.violations, []);
  });

  test('every shard logs one plan line with the same plan sha', () => {
    const lines = planLines(balanced.shards);
    assert.deepStrictEqual(
      lines.map((l) => l.length),
      [1, 1, 1]
    );
    assert.strictEqual(new Set(lines.map((l) => planShaOf(l[0]))).size, 1);
    assert.match(lines[0][0], /\d+\/\d+ tests known/);
  });

  test('passes the finish check against the pinned snapshot', () => {
    const result = checkRun(
      planOf({ mode: 'balanced', total: 3, sha: snapshot.sha, runId: 102 }),
      balanced.records
    );
    assert.deepStrictEqual(result.problems, []);
    for (const record of balanced.records) {
      assert.strictEqual(record.snapshotSha, snapshot.sha);
      assert.strictEqual(record.predictedMs.length, 3);
    }
  });

  test('splits by duration: the predicted shards are even', () => {
    const predicted = balanced.records[0].predictedMs;
    const spread = Math.max(...predicted) - Math.min(...predicted);
    assert.ok(spread <= Math.max(...predicted) * 0.25, `predicted ${predicted}`);
  });

  test('a shard that hosts no setup-dependent test runs no setup, and the rest run it once', () => {
    for (const shard of balanced.shards) {
      const setupRuns = shard.leaves.filter((l) => l.project === 'setup').length;
      const needsSetup = shard.leaves.some(
        (l) => l.project === 'chromium' || l.project === 'firefox'
      );
      assert.strictEqual(setupRuns, needsSetup ? 1 : 0);
    }
  });
});

describe('balanced mode under other selections', () => {
  test('a project that needs no setup: a shard hosting only its tests runs no setup', () => {
    // Setup priced high, so the plan keeps the shards that need it few.
    const tests = { ...history.tests };
    for (const key of Object.keys(tests)) {
      if (JSON.parse(key)[0] === 'setup') tests[key] = { ...tests[key], samples: [[101, 8000]] };
    }
    const snapshot = writeSnapshot({ ...history, tests });
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { config: 'setup-free.config.js', forward: FORWARD, workers: 1 },
      actionPartition({ total: 3, mode: 'balanced', snapshot, recordDir })
    );
    assert.deepStrictEqual(run.violations, []);
    const setupRuns = run.shards.map((s) => s.leaves.filter((l) => l.project === 'setup').length);
    run.shards.forEach((shard, i) => {
      const needsSetup = shard.leaves.some((l) => l.project === 'chromium');
      assert.strictEqual(setupRuns[i], needsSetup ? 1 : 0, `shard ${i + 1}`);
    });
    assert.ok(setupRuns.includes(0), `setup runs per shard: ${setupRuns}`);
  });

  test('--repeat-each 2: every copy runs once and the check counts each copy apart', () => {
    const snapshot = writeSnapshot(history);
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { forward: FORWARD, workers: 1, repeatEach: 2 },
      actionPartition({ total: 3, mode: 'balanced', snapshot, recordDir, runId: 103 })
    );
    assert.deepStrictEqual(run.violations, []);
    const records = readRecords(recordDir);
    const result = checkRun(
      planOf({ mode: 'balanced', total: 3, sha: snapshot.sha, runId: 103 }),
      records
    );
    assert.deepStrictEqual(result.problems, []);
    const ids = records.flatMap((r) => r.tests.filter((t) => !t.setup));
    assert.ok(ids.some((t) => t.repeat === 1));
  });

  test('--fully-parallel: serial groups stay on one shard, every leaf once', () => {
    const snapshot = writeSnapshot(history);
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { forward: [...FORWARD, '--fully-parallel'], workers: 1 },
      actionPartition({ total: 3, mode: 'balanced', snapshot, recordDir })
    );
    assert.deepStrictEqual(run.violations, []);
  });

  test('a user --reporter=list keeps the added reporter, which still balances', () => {
    const snapshot = writeSnapshot(history);
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { forward: FORWARD, workers: 1 },
      actionPartition({
        total: 2,
        mode: 'balanced',
        snapshot,
        recordDir,
        args: ['--reporter=list'],
      })
    );
    assert.deepStrictEqual(run.violations, []);
    assert.deepStrictEqual(
      planLines(run.shards).map((l) => l.length),
      [1, 1]
    );
    assert.strictEqual(readRecords(recordDir).length, 2);
  });

  test('a TypeScript config, loaded by Playwright itself, balances the same way', () => {
    const snapshot = writeSnapshot(history);
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { config: 'typescript.config.ts', forward: FORWARD, workers: 1 },
      actionPartition({ total: 2, mode: 'balanced', snapshot, recordDir })
    );
    assert.deepStrictEqual(run.violations, []);
    assert.deepStrictEqual(
      planLines(run.shards).map((l) => l.length),
      [1, 1]
    );
    const result = checkRun(
      planOf({ mode: 'balanced', total: 2, sha: snapshot.sha }),
      readRecords(recordDir)
    );
    assert.deepStrictEqual(result.problems, []);
  });

  test('titles that read like a repeat keep their own identity under --repeat-each 2', () => {
    const recordDir = tempDir('psp-records-');
    const config = 'repeat-collision.config.js';
    const nativeRun = runQualified(
      { config, workers: 1, repeatEach: 2 },
      actionPartition({ total: 2, mode: 'native', recordDir })
    );
    assert.deepStrictEqual(nativeRun.violations, []);
    const snapshot = writeSnapshot(publish(readRecords(recordDir)));
    const balancedDir = tempDir('psp-records-');
    const run = runQualified(
      { config, workers: 1, repeatEach: 2 },
      actionPartition({ total: 2, mode: 'balanced', snapshot, recordDir: balancedDir, runId: 104 })
    );
    assert.deepStrictEqual(run.violations, []);
    const records = readRecords(balancedDir);
    const result = checkRun(
      planOf({ mode: 'balanced', total: 2, sha: snapshot.sha, runId: 104 }),
      records
    );
    assert.deepStrictEqual(result.problems, []);
    // 3 tests, 2 projects, 2 repeats: 12 copies, each once.
    assert.strictEqual(records.flatMap((r) => r.tests).length, 12);
  });
});

describe('the plan does not depend on Playwright --workers', () => {
  test('one plan sha under --workers=1 and --workers=4', () => {
    const snapshot = writeSnapshot(history);
    const shas = ['1', '4'].map((workers) => {
      const cli = require.resolve('@playwright/test/cli', { paths: [FIXTURE] });
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'test',
          '--list',
          ...FORWARD,
          '--shard=1/3',
          `--workers=${workers}`,
          `--add-reporter=${REPORTER}`,
        ],
        {
          cwd: FIXTURE,
          encoding: 'utf8',
          env: {
            ...process.env,
            PSP_MODE: 'balanced',
            PSP_KEY: 'fixture-history-key',
            PSP_SNAPSHOT: snapshot.file,
            PSP_SNAPSHOT_SHA: snapshot.sha,
          },
        }
      );
      assert.strictEqual(result.status, 0, result.stderr);
      return planShaOf(result.stdout.split('\n').find((l) => l.includes('plan ')));
    });
    assert.strictEqual(shas[0], shas[1]);
  });
});
