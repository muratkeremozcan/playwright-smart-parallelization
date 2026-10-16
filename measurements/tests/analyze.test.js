'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeLabel,
  analyzeRun,
  compareLabels,
  dominantDelay,
  outcomeOf,
  packLongestFirst,
  unitKey,
  validateRecord,
} = require('../analyze');
const { SERIAL, makeRecord, makeTest, standard } = require('./support');

const lean = { queue: 1000, setup: 1000, prepare: 0, server: 0, after: 0 };
const clone = (record) => JSON.parse(JSON.stringify(record));

function parts(run) {
  const d = run.decomposition;
  return d.queue + d.fixed + d.share + d.atomicExcess + d.assignmentGap + d.inTestOverhead;
}

test('the standard run has the figures its timeline spells out', () => {
  const run = analyzeRun(standard());
  assert.equal(run.completion, 257000);
  assert.equal(run.queueCritical, 2000 + 4000 + 3000);
  assert.equal(run.execution, 257000 - 9000);
  assert.equal(run.criticalShard, 2);
  assert.deepEqual(
    run.shards.map((s) => s.jobMs),
    [180000, 180000]
  );
  assert.equal(run.decomposition.fixed, 248000 - 20000);
  assert.equal(run.balance.share, 20000);
  assert.equal(run.balance.lowerBound, 20000);
  assert.equal(run.aggregateRunnerMs, 5000 + 180000 + 180000 + 60000);
  const [one] = run.shards;
  assert.equal(one.setupMs, 100000);
  assert.equal(one.prepareMs, 20000);
  assert.equal(one.serverMs, 30000);
  assert.equal(one.spanMs, 20000);
  assert.equal(one.afterMs, 10000);
});

test('the parts of the completion add up to it for every shape', () => {
  const shapes = [
    standard(),
    makeRecord({
      shards: [
        {
          ...lean,
          gap: 700,
          tests: [makeTest('a', [30000]), makeTest('b', [12000]), makeTest('c', [8000])],
        },
        { ...lean, queue: 9000, server: 4000, tests: [makeTest('d', [5000])] },
      ],
    }),
    makeRecord({
      shards: [
        {
          ...lean,
          tests: [
            makeTest('s1', [50000], { file: SERIAL.file, titlePath: [SERIAL.file, SERIAL.suite] }),
          ],
        },
        { ...lean, tests: [makeTest('x', [10000])] },
      ],
      serialSuites: [SERIAL],
    }),
  ];
  for (const record of shapes) {
    const run = analyzeRun(record);
    assert.equal(parts(run), run.completion);
  }
});

test('an overhead between tests shows as in-test overhead, and retries count as work', () => {
  const run = analyzeRun(
    makeRecord({
      shards: [
        { ...lean, gap: 500, tests: [makeTest('a', [4000, 4000]), makeTest('b', [2000])] },
        { ...lean, tests: [makeTest('c', [10000])] },
      ],
    })
  );
  assert.equal(run.shards[0].busy, 10000);
  assert.equal(run.shards[0].spanMs, 11000);
  assert.equal(run.shards[0].retries, 1);
  assert.equal(run.shards[0].flaky, 1);
  assert.equal(run.retries, 1);
  assert.equal(
    run.decomposition.inTestOverhead +
      run.decomposition.assignmentGap +
      run.decomposition.share +
      run.decomposition.atomicExcess,
    run.shards[run.criticalShard - 1].spanMs
  );
});

test('uneven assignment dominates when one shard carries most tests and setup is small', () => {
  const many = Array.from({ length: 30 }, (_, i) => makeTest(`m${i}`, [10000]));
  const run = analyzeRun(
    makeRecord({
      shards: [
        { ...lean, tests: many },
        { ...lean, tests: [makeTest('z', [10000])] },
      ],
    })
  );
  assert.equal(run.decomposition.atomicExcess, 0);
  assert.equal(run.decomposition.assignmentGap, 300000 - 155000);
  assert.equal(dominantDelay(run.decomposition), 'uneven assignment');
});

test('an oversized serial group dominates when it exceeds the ideal share and setup is small', () => {
  const serial = makeTest('s', [600000], {
    file: SERIAL.file,
    titlePath: [SERIAL.file, SERIAL.suite],
  });
  const run = analyzeRun(
    makeRecord({
      shards: [
        { ...lean, tests: [serial] },
        { ...lean, tests: [makeTest('z', [10000])] },
      ],
      serialSuites: [SERIAL],
    })
  );
  assert.equal(run.balance.largestUnit, 600000);
  assert.equal(run.decomposition.atomicExcess, 600000 - 305000);
  assert.equal(run.decomposition.assignmentGap, 0);
  assert.equal(dominantDelay(run.decomposition), 'one oversized atomic group');
});

test('fixed setup cost dominates the standard shape', () => {
  assert.equal(dominantDelay(analyzeRun(standard()).decomposition), 'fixed setup cost');
});

test('dominantDelay picks the largest of the three and keeps the first on a tie', () => {
  assert.equal(dominantDelay({ fixed: 1, atomicExcess: 2, assignmentGap: 3 }), 'uneven assignment');
  assert.equal(
    dominantDelay({ fixed: 1, atomicExcess: 3, assignmentGap: 2 }),
    'one oversized atomic group'
  );
  assert.equal(dominantDelay({ fixed: 3, atomicExcess: 2, assignmentGap: 1 }), 'fixed setup cost');
  assert.equal(dominantDelay({ fixed: 2, atomicExcess: 2, assignmentGap: 2 }), 'fixed setup cost');
});

test('the lower bound is the larger of the ideal share and the largest atomic group', () => {
  const balanced = analyzeRun(standard()).balance;
  assert.equal(balanced.lowerBound, 20000);
  assert.deepEqual(balanced.bounds, { 2: 20000, 3: 20000, 4: 20000, 6: 20000, 8: 20000 });
  const small = Array.from({ length: 8 }, (_, i) => makeTest(`s${i}`, [5000]));
  const fine = analyzeRun(
    makeRecord({
      shards: [
        { ...lean, tests: small.slice(0, 4) },
        { ...lean, tests: small.slice(4) },
      ],
    })
  ).balance;
  assert.deepEqual(fine.bounds, { 2: 20000, 3: 40000 / 3, 4: 10000, 6: 40000 / 6, 8: 5000 });
  const serial = makeTest('s', [50000], {
    file: SERIAL.file,
    titlePath: [SERIAL.file, SERIAL.suite],
  });
  const big = analyzeRun(
    makeRecord({
      shards: [
        { ...lean, tests: [serial] },
        { ...lean, tests: [makeTest('z', [10000])] },
      ],
      serialSuites: [SERIAL],
    })
  ).balance;
  assert.equal(big.lowerBound, 50000);
  assert.equal(big.bounds[8], 50000);
});

test('longest-first packing never beats the lower bound', () => {
  assert.equal(packLongestFirst([7, 6, 5, 4, 3, 2], 2), 14);
  assert.equal(packLongestFirst([10], 3), 10);
  const balance = analyzeRun(standard()).balance;
  assert.ok(balance.packed >= balance.lowerBound);
});

test('a serial group is one atomic unit, a test is one unit under fullyParallel, a file otherwise', () => {
  const record = standard({ serialSuites: [SERIAL] });
  const serialTest = makeTest('s', [1], {
    file: SERIAL.file,
    titlePath: [SERIAL.file, 'Outer', SERIAL.suite],
  });
  assert.equal(unitKey(serialTest, record), `chromium::${SERIAL.file}::${SERIAL.suite}`);
  const plain = makeTest('p', [1], { file: 'p.spec.ts' });
  assert.equal(unitKey(plain, record), 'p');
  assert.equal(
    unitKey(plain, { ...record, facts: { fullyParallel: false } }),
    'chromium::p.spec.ts'
  );
  assert.equal(
    unitKey(makeTest('q', [1], { file: SERIAL.file, titlePath: [SERIAL.file, 'Other'] }), record),
    'q'
  );
});

test('a serial group split across shards, or a serial suite that matches no test, is an error', () => {
  const inSerial = (id) =>
    makeTest(id, [1000], { file: SERIAL.file, titlePath: [SERIAL.file, SERIAL.suite] });
  const split = makeRecord({
    shards: [
      { ...lean, tests: [inSerial('a')] },
      { ...lean, tests: [inSerial('b')] },
    ],
    serialSuites: [SERIAL],
  });
  assert.throws(() => analyzeRun(split), /split across shards/);
  assert.throws(
    () => analyzeRun(standard({ serialSuites: [{ file: 'gone.spec.ts', suite: 'Gone' }] })),
    /matches no test/
  );
});

test('outcomes: passed, flaky, failed, skipped and a test with no attempt', () => {
  assert.equal(outcomeOf(makeTest('a', [1])), 'passed');
  assert.equal(outcomeOf(makeTest('a', [1, 1])), 'flaky');
  assert.equal(outcomeOf(makeTest('a', [1, 1, 1], { status: 'failed' })), 'failed');
  assert.equal(outcomeOf(makeTest('a', [0], { status: 'skipped' })), 'skipped');
  assert.equal(outcomeOf(makeTest('a', [1], { status: 'interrupted' })), 'failed');
  assert.equal(outcomeOf({ attempts: [] }), 'failed');
});

test('a failed run keeps its timings and counts its failures', () => {
  const failing = makeRecord({
    conclusion: 'failure',
    shards: [
      {
        ...lean,
        conclusion: 'failure',
        tests: [makeTest('f', [3000, 3000, 3000], { status: 'failed' })],
      },
      { ...lean, tests: [makeTest('ok', [3000])] },
    ],
  });
  const run = analyzeRun(failing);
  assert.equal(run.excluded, undefined);
  assert.equal(run.failed, 1);
  assert.equal(run.retries, 2);
  assert.equal(run.conclusion, 'failure');
});

test('runs without complete shard timings are excluded with the reason', () => {
  const noBlob = standard();
  noBlob.shards[1].blob = null;
  noBlob.shards[1].blobMissing = 'no blob artifact was uploaded';
  assert.match(analyzeRun(noBlob).excluded, /shard 2: no blob artifact/);
  const noStep = makeRecord({
    shards: [
      { ...lean, noTestStep: true, tests: [makeTest('a', [1000])] },
      { ...lean, tests: [makeTest('b', [1000])] },
    ],
  });
  assert.equal(analyzeRun(noStep).excluded, 'shard 1 never reached "Run suite"');
  const cancelledStep = makeRecord({
    shards: [
      { ...lean, testStepConclusion: 'cancelled', tests: [makeTest('a', [1000])] },
      { ...lean, tests: [makeTest('b', [1000])] },
    ],
  });
  assert.equal(analyzeRun(cancelledStep).excluded, 'shard 1 stopped at "Run suite" (cancelled)');
  const empty = standard();
  empty.shards[0].blob.tests = [];
  assert.match(analyzeRun(empty).excluded, /ran no test/);
});

test('a shard stopped before the tests names the step and the first error of its log', () => {
  const stopped = makeRecord({
    conclusion: 'cancelled',
    shards: [
      { ...lean, tests: [makeTest('a', [1000])] },
      {
        ...lean,
        conclusion: 'cancelled',
        stoppedAt: 'Start services',
        failureNote: 'studio Error toomanyrequests: Data limit exceeded',
        blobMissing: 'no blob artifact was uploaded',
        tests: [],
      },
    ],
  });
  assert.equal(
    analyzeRun(stopped).excluded,
    'shard 2 stopped at "Start services" (cancelled): studio Error toomanyrequests: Data limit exceeded'
  );
});

test('a cancelled run whose shards finished their tests keeps its timings', () => {
  const run = analyzeRun(standard({ conclusion: 'cancelled' }));
  assert.equal(run.excluded, undefined);
  assert.equal(run.conclusion, 'cancelled');
});

test('a failing test step keeps its timings', () => {
  const failing = makeRecord({
    conclusion: 'failure',
    shards: [
      { ...lean, testStepConclusion: 'failure', tests: [makeTest('a', [1000])] },
      { ...lean, tests: [makeTest('b', [1000])] },
    ],
  });
  assert.equal(analyzeRun(failing).excluded, undefined);
});

test('validateRecord refuses a record it cannot trust', () => {
  const bad = (mutate, pattern) => {
    const record = clone(standard());
    mutate(record);
    assert.throws(() => validateRecord(record), pattern);
  };
  bad((r) => (r.schema = 2), /schema/);
  bad((r) => (r.run.attempt = 2), /only first attempts/);
  bad((r) => (r.run.status = 'in_progress'), /not completed/);
  bad((r) => (r.shards = []), /missing/);
  bad((r) => (r.shards[0].jobId = 999), /has no job/);
  bad((r) => (r.shards[0].total = 3), /reports 3 shards/);
  bad((r) => (r.shards[1].blob.shard.current = 1), /is shard 1/);
  bad((r) => (r.shards[1].blob.tests[0].id = 't1'), /ran in two shards/);
  bad((r) => {
    r.shards[1].blob = null;
  }, /neither a blob nor a reason/);
});

test('a skipped job with impossible timestamps is ignored', () => {
  const run = analyzeRun(standard());
  assert.equal(run.aggregateRunnerMs, 5000 + 180000 + 180000 + 60000);
  assert.equal(run.completion, 257000);
});

test('analyzeLabel counts every run in the pass rate and every timed run in the medians', () => {
  const ok1 = analyzeRun(standard({ id: 1 }));
  const ok2 = analyzeRun(
    makeRecord({
      id: 2,
      mergeMs: 160000,
      shards: [
        {
          queue: 2000,
          setup: 100000,
          prepare: 20000,
          server: 30000,
          after: 10000,
          tests: [makeTest('a', [10000])],
        },
        {
          queue: 4000,
          setup: 100000,
          prepare: 20000,
          server: 30000,
          after: 10000,
          tests: [makeTest('b', [10000])],
        },
      ],
    })
  );
  const stoppedRecord = standard({ id: 3, conclusion: 'cancelled' });
  stoppedRecord.shards[1].blob = null;
  stoppedRecord.shards[1].blobMissing = 'no blob artifact was uploaded';
  const cancelled = analyzeRun(stoppedRecord);
  const failed = analyzeRun(standard({ id: 4, conclusion: 'failure' }));
  const label = analyzeLabel('a', [ok1, ok2, cancelled, failed]);
  assert.equal(label.runs, 4);
  assert.equal(label.succeeded, 2);
  assert.equal(label.timed, 3);
  assert.deepEqual(label.excluded, [{ id: 3, why: 'shard 2: no blob artifact was uploaded' }]);
  assert.equal(label.completion.n, 3);
  assert.equal(label.completion.max, 347000);
  assert.equal(label.completion.median, 257000);
  assert.equal(label.dominant, 'fixed setup cost');
});

test('compareLabels reports the median change and whether the ranges overlap', () => {
  const run = (id, mergeMs) => analyzeRun(standard({ id, mergeMs }));
  const a = [run(1, 60000), run(2, 62000), run(3, 64000)];
  const near = [run(4, 63000), run(5, 65000), run(6, 67000)];
  const far = [run(7, 160000), run(8, 162000), run(9, 164000)];
  const close = compareLabels(a, near, (r) => r.completion);
  assert.equal(close.delta, 3000);
  assert.equal(close.overlap, true);
  const apart = compareLabels(a, far, (r) => r.completion);
  assert.equal(apart.delta, 100000);
  assert.equal(apart.overlap, false);
  assert.ok(Math.abs(apart.ratio - 100000 / 259000) < 1e-9);
});

test('a job that completed when the first shard started counts as before the shards', () => {
  const record = standard();
  const firstStart = Math.min(
    ...record.jobs.filter((j) => j.name.startsWith('pw-e2e')).map((j) => Date.parse(j.startedAt))
  );
  const vars = record.jobs.find((j) => j.name === 'vars');
  vars.completedAt = new Date(firstStart).toISOString();
  const exact = analyzeRun(record);
  assert.equal(exact.beforeMs, firstStart - Date.parse(vars.startedAt));
  assert.equal(exact.queueCritical, 2000 + 4000 + 3000);
  vars.completedAt = new Date(firstStart + 1000).toISOString();
  const late = analyzeRun(record);
  assert.equal(late.beforeMs, 0);
  assert.equal(late.afterJobsMs, firstStart + 1000 - Date.parse(vars.startedAt) + 60000);
});

test('a job that started before it was created is an error', () => {
  const record = standard();
  const vars = record.jobs.find((j) => j.name === 'vars');
  vars.startedAt = new Date(Date.parse(vars.createdAt) - 1000).toISOString();
  assert.throws(() => analyzeRun(record), /started before it was created/);
});

test('more than one worker, a missing shard number and a missing pair are refused', () => {
  const bad = (mutate, pattern) => {
    const record = clone(standard());
    mutate(record);
    assert.throws(() => validateRecord(record), pattern);
  };
  bad((r) => (r.shards[0].blob.workers = 2), /runs 2 workers/);
  bad((r) => (r.shards[0].blob.shard = null), /has no shard/);
  bad((r) => (r.shards[1].index = 3), /shard indices are not 1 to N/);
  bad((r) => delete r.pair, /no pair number/);
  bad((r) => (r.shards[0].blob = undefined), /neither a blob nor a reason/);
});

test('the same serial file in two projects is two atomic units', () => {
  const inSerial = (id, project) => ({
    ...makeTest(id, [1000], { file: SERIAL.file, titlePath: [SERIAL.file, SERIAL.suite] }),
    project,
  });
  const record = makeRecord({
    shards: [
      { ...lean, tests: [inSerial('a', 'chromium')] },
      { ...lean, tests: [inSerial('b', 'firefox')] },
    ],
    serialSuites: [SERIAL],
  });
  assert.equal(analyzeRun(record).balance.units, 2);
});

test('stages before or after the shards must not run in parallel', () => {
  const record = standard();
  const vars = record.jobs.find((j) => j.name === 'vars');
  const twin = { ...clone(vars), id: 102, name: 'vars-2' };
  record.jobs.push(twin);
  assert.throws(() => analyzeRun(record), /run in parallel/);
});

test('a job that never started is left out instead of aborting the run', () => {
  const record = standard();
  record.jobs.push({
    ...clone(record.jobs[0]),
    id: 103,
    name: 'never started',
    conclusion: 'cancelled',
    startedAt: null,
    completedAt: null,
  });
  assert.equal(analyzeRun(record).completion, 257000);
});

test('a test that never ran does not count as a negative retry', () => {
  const record = standard();
  record.shards[0].blob.tests[0].attempts = [];
  const run = analyzeRun(record);
  assert.equal(run.retries, 0);
  assert.equal(run.failed, 1);
});
