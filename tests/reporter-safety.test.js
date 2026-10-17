/**
 * How the Action's reporter fails, on the real fixture: a shard whose snapshot is damaged or
 * differs from the pinned one stops before any test, an unnamed project is refused before any
 * test, a run stopped by --max-failures and a run where every test skipped fail the finish check,
 * and a balanced run under the network guard makes no connection and starts no program beyond
 * what the same shards start without the reporter.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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
const { runPartition } = require('../harness/index.js');

const FORWARD = ['--grep-invert=oversized'];
const GUARD = path.join(__dirname, '..', 'qualification', 'lib', 'net-guard.js');
const SLOW_CLOCK = path.join(__dirname, '..', 'qualification', 'lib', 'slow-clock.js');

let history;

before(() => {
  requireFixture();
  const recordDir = tempDir('psp-records-');
  runPartition(
    { cwd: FIXTURE, forward: FORWARD, workers: 1 },
    actionPartition({ total: 2, mode: 'native', recordDir })
  );
  history = publish(readRecords(recordDir));
});

const executed = (shard) => (shard.leaves || []).filter((leaf) => leaf.attempts > 0).length;

describe('a shard with other snapshot bytes stops before any test', () => {
  test('a truncated snapshot: that shard exits 1 with no test run, no test runs twice', () => {
    const snapshot = writeSnapshot(history);
    const damaged = path.join(tempDir('psp-damaged-'), 'history.json');
    fs.writeFileSync(damaged, snapshot.text.slice(0, snapshot.text.length >> 1));
    const recordDir = tempDir('psp-records-');
    const run = runQualified(
      { forward: FORWARD, workers: 1 },
      actionPartition({
        total: 3,
        mode: 'balanced',
        recordDir,
        snapshot: [snapshot, { file: damaged, sha: snapshot.sha }, snapshot],
      })
    );
    assert.deepStrictEqual(
      run.shards.map((s) => s.exitCode),
      [0, 1, 0]
    );
    assert.strictEqual(executed(run.shards[1]), 0);
    assert.match(run.shards[1].output, /snapshot has sha .* the pin holds .*strict/);
    assert.ok(!run.violations.some((v) => v.kind === 'duplicate'));
    const result = checkRun(
      planOf({ mode: 'balanced', total: 3, sha: snapshot.sha }),
      readRecords(recordDir)
    );
    assert.strictEqual(result.ok, false);
  });

  test('a valid snapshot that is not the pinned one stops its shard the same way', () => {
    const snapshot = writeSnapshot(history);
    const other = writeSnapshot(publish([], { base: history, runId: 999 }));
    assert.notStrictEqual(other.sha, snapshot.sha);
    const run = runQualified(
      { forward: FORWARD, workers: 1 },
      actionPartition({
        total: 2,
        mode: 'balanced',
        recordDir: tempDir('psp-records-'),
        snapshot: [snapshot, { file: other.file, sha: snapshot.sha }],
      })
    );
    assert.deepStrictEqual(
      run.shards.map((s) => s.exitCode),
      [0, 1]
    );
    assert.strictEqual(executed(run.shards[1]), 0);
  });
});

test('two unnamed projects are refused before any test', () => {
  const recordDir = tempDir('psp-records-');
  const [shard] = runPartition(
    { cwd: FIXTURE, config: 'unnamed.config.js', workers: 1 },
    actionPartition({ total: 1, mode: 'native', recordDir })
  );
  assert.strictEqual(shard.exitCode, 1);
  assert.match(shard.output, /projects 1 and 2 of the config have no name/);
  assert.strictEqual(executed(shard), 0);
});

test("one unnamed project, a config without projects, keeps the identity '' and balances", () => {
  // The harness refuses unnamed projects, so the shards run with the Action's reporter alone.
  const cli = require.resolve('@playwright/test/cli', { paths: [FIXTURE] });
  const shards = (mode, snapshot, recordDir) =>
    actionPartition({ total: 2, mode, snapshot, recordDir }).map((shard) =>
      spawnSync(
        process.execPath,
        [
          cli,
          'test',
          '--config=no-projects.config.js',
          ...FORWARD,
          '--workers=1',
          shard.args[0],
          `--add-reporter=${REPORTER}`,
        ],
        { cwd: FIXTURE, encoding: 'utf8', env: { ...process.env, ...shard.env } }
      )
    );
  const nativeDir = tempDir('psp-records-');
  assert.deepStrictEqual(
    shards('native', null, nativeDir).map((r) => r.status),
    [0, 0]
  );
  const records = readRecords(nativeDir);
  assert.deepStrictEqual(checkRun(planOf({ mode: 'native', total: 2 }), records).problems, []);
  const history = publish(records);
  assert.ok(Object.keys(history.tests).every((key) => JSON.parse(key)[0] === ''));
  const snapshot = writeSnapshot(history);
  const balancedDir = tempDir('psp-records-');
  const runs = shards('balanced', snapshot, balancedDir);
  assert.deepStrictEqual(
    runs.map((r) => r.status),
    [0, 0]
  );
  assert.deepStrictEqual(
    planLines(runs.map((r) => ({ output: r.stdout }))).map((l) => l.length),
    [1, 1]
  );
  const result = checkRun(
    planOf({ mode: 'balanced', total: 2, sha: snapshot.sha }),
    readRecords(balancedDir)
  );
  assert.deepStrictEqual(result.problems, []);
});

test('a shard stopped by --max-failures fails the check and names the tests that did not run', () => {
  const recordDir = tempDir('psp-records-');
  runPartition(
    { cwd: FIXTURE, forward: [...FORWARD, '--max-failures=1'], workers: 1 },
    actionPartition({
      total: 2,
      mode: 'native',
      recordDir,
      env: { PSP_FIXTURE_FAIL: 'loads the page' },
    })
  );
  const records = readRecords(recordDir);
  assert.strictEqual(records.length, 2, 'a stopped shard still writes its record');
  const result = checkRun(planOf({ mode: 'native', total: 2 }), records);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.problems.some((p) => /test\(s\) did not run/.test(p)),
    result.problems.join('\n')
  );
});

test('a run where every test skipped fails the check', () => {
  const recordDir = tempDir('psp-records-');
  runPartition(
    { cwd: FIXTURE, forward: FORWARD, workers: 1 },
    actionPartition({ total: 2, mode: 'native', recordDir, env: { PSP_FIXTURE_SKIP_ALL: '1' } })
  );
  const result = checkRun(planOf({ mode: 'native', total: 2 }), readRecords(recordDir));
  assert.ok(
    result.problems.some((p) => /every one of the .* tests skipped/.test(p)),
    result.problems.join('\n')
  );
});

describe('a balanced run makes no network call', () => {
  const guarded = (withReporter) => {
    const log = path.join(tempDir('psp-guard-'), 'guard.log');
    fs.writeFileSync(log, '');
    const snapshot = writeSnapshot(history);
    const partition = actionPartition({
      total: 2,
      mode: 'balanced',
      snapshot,
      recordDir: tempDir('psp-records-'),
      env: { NODE_OPTIONS: `--require ${GUARD}`, PSP_NET_GUARD_LOG: log, CI: '' },
    });
    const shards = runPartition(
      { cwd: FIXTURE, forward: FORWARD, workers: 1 },
      withReporter ? partition : partition.map((s) => ({ args: [s.args[0]], env: s.env }))
    );
    const entries = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const programs = entries
      .filter((e) => e.kind === 'spawn')
      .map((e) => path.basename(e.target))
      .filter((name) => !/^(node|.*\.js)$/.test(name) && name !== path.basename(process.execPath))
      .sort();
    return {
      shards,
      entries: entries.length,
      network: entries.filter((e) => e.kind !== 'spawn'),
      programs,
    };
  };

  test('zero connection attempts and no program the run without it does not start', () => {
    const control = spawnSync(
      process.execPath,
      ['-e', "fetch('https://example.invalid/').catch(() => {})"],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--require ${GUARD}`,
          PSP_NET_GUARD_LOG: path.join(tempDir('psp-guard-'), 'c.log'),
        },
      }
    );
    assert.strictEqual(control.status, 0);
    const withIt = guarded(true);
    const without = guarded(false);
    assert.deepStrictEqual(
      withIt.shards.map((s) => s.exitCode),
      [0, 0]
    );
    assert.deepStrictEqual(
      planLines(withIt.shards).map((l) => l.length),
      [1, 1]
    );
    assert.ok(withIt.entries > 0, 'the guard was loaded: it logged the worker processes');
    assert.deepStrictEqual(withIt.network, []);
    assert.deepStrictEqual(withIt.programs, without.programs);
  });
});

test('a clock that jumps a second on every read leaves the plan as it is', () => {
  const snapshot = writeSnapshot(history);
  const planSha = (nodeOptions) => {
    const cli = require.resolve('@playwright/test/cli', { paths: [FIXTURE] });
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '--list', ...FORWARD, '--shard=2/3', `--add-reporter=${REPORTER}`],
      {
        cwd: FIXTURE,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions,
          PSP_MODE: 'balanced',
          PSP_KEY: 'fixture-history-key',
          PSP_SNAPSHOT: snapshot.file,
          PSP_SNAPSHOT_SHA: snapshot.sha,
        },
      }
    );
    assert.strictEqual(result.status, 0, result.stderr);
    return planShaOf(result.stdout.split('\n').find((l) => l.includes('plan ')));
  };
  assert.strictEqual(planSha(`--require ${SLOW_CLOCK}`), planSha(''));
});
