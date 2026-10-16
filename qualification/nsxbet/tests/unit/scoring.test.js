/**
 * Tests that a violation in a run decides the row that scores the run. A leaf that skipped or never
 * ran (`not-executed`) must fail every row, however clean the rest of the run is.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { COVERAGE_KINDS, coverageKinds, coverageRow } = require('../../scenarios/coverage');
const { dependencyRow, serialRow } = require('../../scenarios/serial');

const run = (kinds = {}, groups = []) => ({
  summary: {
    kinds,
    groups,
    shards: [{ index: 1, exitCode: 0 }],
  },
  report: { dependencyExecutions: {} },
  partition: [],
});

describe('coverageKinds', () => {
  test('counts missing, duplicate, unexpected and not-executed leaves', () => {
    assert.deepStrictEqual(COVERAGE_KINDS, ['missing', 'duplicate', 'unexpected', 'not-executed']);
    assert.deepStrictEqual(
      coverageKinds({
        missing: 1,
        duplicate: 2,
        unexpected: 3,
        'not-executed': 4,
        'serial-split': 5,
      }),
      { missing: 1, duplicate: 2, unexpected: 3, 'not-executed': 4 }
    );
  });
});

describe('a clean run passes every row that scores it', () => {
  test('coverage, serial and dependency rows', () => {
    assert.strictEqual(coverageRow('c', 1, 't', run()).status, 'pass');
    assert.strictEqual(serialRow('s', 't', run()).status, 'pass');
    assert.strictEqual(dependencyRow([run()]).status, 'pass');
  });
});

describe('a skipped leaf fails every row that scores the run', () => {
  const skipped = run({ 'not-executed': 56 });

  test('a coverage row', () => {
    const row = coverageRow('c', 1, 't', skipped);
    assert.strictEqual(row.status, 'fail');
    assert.deepStrictEqual(row.evidence.coverageViolations, { 'not-executed': 56 });
  });

  test('a serial row', () => {
    const row = serialRow('s', 't', skipped);
    assert.strictEqual(row.status, 'fail');
    assert.deepStrictEqual(row.evidence.coverageViolations, { 'not-executed': 56 });
  });

  test('the dependency row', () => {
    assert.strictEqual(dependencyRow([run(), skipped]).status, 'fail');
  });

  test('one skipped leaf is enough', () => {
    assert.strictEqual(coverageRow('c', 1, 't', run({ 'not-executed': 1 })).status, 'fail');
  });
});

describe('the other violations still decide their rows', () => {
  test('a duplicate fails a coverage row and a split group fails a serial row', () => {
    assert.strictEqual(coverageRow('c', 1, 't', run({ duplicate: 1 })).status, 'fail');
    assert.strictEqual(serialRow('s', 't', run({ 'serial-split': 1 }, ['g'])).status, 'fail');
  });

  test('a dependency violation fails the dependency row', () => {
    assert.strictEqual(dependencyRow([run({ 'dependency-missing': 1 })]).status, 'fail');
  });
});
