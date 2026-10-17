/**
 * The exactly-once check of the finish action over synthetic records: every way a run can be
 * incomplete, repeated, mixed or from elsewhere fails it, and a complete run passes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  RECORD_SCHEMA,
  START_SCHEMA,
  STATUS_SCHEMA,
  checkRun,
  latestAttempts,
  unanswered,
  validateRecord,
  validateStart,
  validateStatus,
} = require('../lib/check');

const SHA = 'a'.repeat(64);
const plan = { total: 2, runId: 7 };

function record(shard, tests, extra = {}) {
  return {
    schema: RECORD_SCHEMA,
    version: 1,
    run: { id: 7, attempt: 1 },
    shard: { current: shard, total: 2 },
    mode: 'balanced',
    fingerprint: 'fp',
    planSha: 'p'.repeat(64),
    snapshotSha: SHA,
    predictedMs: [100, 100],
    status: 'passed',
    wallMs: 100,
    testsMs: 90,
    corpus: [
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ],
    tests: tests.map((id) => ({
      id,
      key: `["p","f","${id}"]`,
      repeat: 0,
      setup: false,
      outcome: 'expected',
      ran: true,
      sample_ms: 10,
    })),
    ...extra,
  };
}

const complete = () => [record(1, ['a', 'b']), record(2, ['c'])];
const problems = (records, p = plan) => checkRun(p, records).problems.join('\n');

test('a complete run passes', () => {
  const result = checkRun(plan, complete());
  assert.deepStrictEqual(result.problems, []);
  assert.ok(result.ok && result.coverageOk && result.passed);
});

describe('fails', () => {
  test('with no records', () => assert.match(problems([]), /no run records/));
  test('with a missing shard', () =>
    assert.match(problems([record(1, ['a', 'b'])]), /no record for shard 2/));
  test('with two records of one shard and attempt', () => {
    assert.match(
      problems([...complete(), record(2, ['c'])]),
      /shard 2 has more than one record of the same attempt/
    );
  });
  test('with a record of another run', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c'], { run: { id: 8, attempt: 1 } })]),
      /record of run 8/
    );
  });
  test('with a shard of another mode', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c'], { mode: 'native' })]),
      /different modes: balanced \(shards 1\) and native \(shards 2\)/
    );
  });
  test('with another fingerprint', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c'], { fingerprint: 'other' })]),
      /different fingerprints: fp \(shards 1\) and other \(shards 2\)/
    );
  });
  test('with a shard that planned from another snapshot', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c'], { snapshotSha: 'b'.repeat(64) })]),
      /different snapshots/
    );
  });
  test('with two plans', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c'], { planSha: 'q'.repeat(64) })]),
      /planned differently/
    );
  });
  test('with two corpora', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c'], { corpus: [['c', 'C']] })]),
      /different test sets/
    );
  });
  test('with no corpus', () => {
    assert.match(
      problems([record(1, ['a', 'b'], { corpus: null }), record(2, ['c'], { corpus: null })]),
      /no corpus/
    );
  });
  test('with a test in two shards', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['b', 'c'])]),
      /1 test\(s\) ran in more than one shard: B/
    );
  });
  test('with a test in no shard', () => {
    assert.match(problems([record(1, ['a']), record(2, ['c'])]), /1 test\(s\) ran in no shard: B/);
  });
  test('with a test outside the corpus', () => {
    assert.match(
      problems([record(1, ['a', 'b']), record(2, ['c', 'z'])]),
      /ran outside the corpus: z/
    );
  });
  test('with a test that did not run', () => {
    const records = complete();
    records[1].tests[0].ran = false;
    assert.match(problems(records), /1 test\(s\) did not run/);
  });
  test('with a failed shard, which leaves the coverage proven', () => {
    const result = checkRun(plan, [record(1, ['a', 'b']), record(2, ['c'], { status: 'failed' })]);
    assert.ok(result.coverageOk);
    assert.strictEqual(result.ok, false);
    assert.match(result.problems.join('\n'), /shard 2 ended with status failed/);
  });
  test('when every test skipped', () => {
    const records = complete();
    for (const r of records) for (const t of r.tests) t.outcome = 'skipped';
    assert.match(problems(records), /every one of the 3 tests skipped/);
  });
});

test('an intentional skip passes', () => {
  const records = complete();
  records[0].tests[0].outcome = 'skipped';
  assert.deepStrictEqual(checkRun(plan, records).problems, []);
});

test('setup tests that every shard ran are not duplicates', () => {
  const records = complete();
  for (const r of records)
    r.tests.push({
      id: 's',
      key: '["setup","s","s"]',
      repeat: 0,
      setup: true,
      outcome: 'expected',
      ran: true,
      sample_ms: 5,
    });
  assert.deepStrictEqual(checkRun(plan, records).problems, []);
});

test('a re-run shard counts its latest attempt only', () => {
  const stale = record(2, ['b', 'c'], { status: 'failed' });
  const rerun = record(2, ['c'], { run: { id: 7, attempt: 2 } });
  const result = checkRun(plan, [record(1, ['a', 'b']), stale, rerun]);
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(latestAttempts([stale, rerun]).latest[0].run.attempt, 2);
  assert.strictEqual(latestAttempts([rerun, stale]).latest[0].run.attempt, 2, 'in either order');
  assert.deepStrictEqual(checkRun(plan, [rerun, record(1, ['a', 'b']), stale]).problems, []);
});

test('a record of an earlier attempt stands in for a shard the re-run did not repeat', () => {
  // Every attempt of a run plans from the one pinned snapshot, so its records agree.
  const result = checkRun(plan, [
    record(1, ['a', 'b'], { run: { id: 7, attempt: 1 } }),
    record(2, ['c'], { run: { id: 7, attempt: 2 } }),
  ]);
  assert.deepStrictEqual(result.problems, []);
});

test('validateStatus takes the status a disabled shard leaves', () => {
  const status = {
    schema: STATUS_SCHEMA,
    version: 1,
    mode: 'disabled',
    run: { id: 7, attempt: 1 },
    key: 'k',
    job: 'test',
  };
  assert.ok(validateStatus(status));
  assert.throws(() => validateStatus({ ...status, mode: 'native' }), /not a status record/);
});

test('validateRecord refuses something that is not a record', () => {
  assert.throws(() => validateRecord({ schema: 'other' }), /not a run record/);
  assert.throws(
    () => validateRecord({ ...record(1, ['a']), tests: [{ id: 1 }] }),
    /not a run record/
  );
  assert.ok(validateRecord(record(1, ['a'])));
});

describe('start markers', () => {
  const start = (token, attempt = 2) => ({
    schema: START_SCHEMA,
    version: 1,
    token,
    run: { id: 1, attempt },
    key: 'k',
    job: 'test',
  });

  test('validateStart takes the marker a main step uploads and refuses anything else', () => {
    assert.strictEqual(validateStart(start('t1')).token, 't1');
    assert.throws(() => validateStart({ ...start('t1'), token: '' }), /not a start marker/);
    assert.throws(() => validateStart({ schema: START_SCHEMA }), /not a start marker/);
  });

  test('tries of one upload share a token and count as one start', () => {
    const tries = [start('t1'), start('t1'), start('t2')];
    assert.deepStrictEqual(
      unanswered(tries, [{ start: 't1' }]).map((s) => s.token),
      ['t2']
    );
    assert.strictEqual(unanswered([start('t1'), start('t1')], []).length, 1);
  });
});
