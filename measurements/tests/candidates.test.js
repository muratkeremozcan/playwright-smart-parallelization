'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  correctnessOf,
  configOf,
  engineCheck,
  parseDuration,
  parseEngine,
  render,
} = require('../candidates');
const { analyzeRun } = require('../analyze');
const { armRecord, makeRecord, makeTest, standard } = require('./support');

const SETUP = 'Start local Supabase services';
const MINUTE = 60000;
const base = { queue: 2000, setup: 100000, prepare: 20000, server: 30000, after: 10000 };

/** Names the setup step of every shard job the way couture-cast does. */
function withSetupStep(record) {
  return {
    ...record,
    jobs: record.jobs.map((job) => ({
      ...job,
      steps: job.steps.map((s) => (s.name === 'Install' ? { ...s, name: SETUP } : s)),
    })),
  };
}

const control = (id, pair, comparison, start, overrides = {}) =>
  armRecord(withSetupStep(standard({ label: 'control', id, pair, start, ...overrides })), {
    comparison,
    cacheLines: ['Cache restored from key: npm-abc'],
  });

/** Three shards, each with one 10 s test: faster than the control's 20 s critical shard. */
function threeShards(id, pair, start, { failed = false, flaky = false } = {}) {
  const third = failed
    ? makeTest('t3', [5000, 5000, 5000], { status: 'failed' })
    : flaky
      ? makeTest('t3', [5000, 5000])
      : makeTest('t3', [10000]);
  return armRecord(
    withSetupStep(
      makeRecord({
        label: 'shards-3',
        id,
        pair,
        start,
        shards: [
          { ...base, tests: [makeTest('t1', [10000])] },
          { ...base, tests: [makeTest('t2', [10000])] },
          { ...base, tests: [third] },
        ],
      })
    ),
    { cacheLines: ['Cache not found for input keys: npm-abc'] }
  );
}

const PLAN = (shard) => [
  '[flakiness.io] balancing 2 shards',
  '[flakiness.io]   duration hints: 3/3 tests (100%)',
  '[flakiness.io]   shard loads:    1=20.0s, 2=20.0s',
  '[flakiness.io]   balance:        100%',
  `[flakiness.io] Shard ${shard}/2 finished: predicted 1m 16s of work, actual 1m 18s (3%)`,
];

function flakiness(id, pair, start, phase = 'measured', lines = PLAN(1)) {
  const label = phase === 'measured' ? 'flakiness' : 'flakiness-warmup';
  return armRecord(withSetupStep(standard({ label, id, pair, start })), {
    phase,
    engine: 'flakiness',
    engineLines: lines,
  });
}

const workers2 = (id, pair, start) =>
  armRecord(withSetupStep(standard({ label: 'workers-2', id, pair, start })), { workers: 2 });

function dataset() {
  return [
    flakiness(90, 1, -30 * MINUTE, 'warm-up'),
    control(1, 1, 'shards-3', 0),
    threeShards(2, 1, 10 * MINUTE),
    flakiness(3, 1, 20 * MINUTE),
    control(4, 1, 'flakiness', 30 * MINUTE),
    threeShards(5, 2, 40 * MINUTE),
    control(6, 2, 'shards-3', 50 * MINUTE),
    control(7, 2, 'flakiness', 60 * MINUTE),
    flakiness(8, 2, 70 * MINUTE),
    control(9, 1, 'workers-2', 80 * MINUTE),
    workers2(10, 1, 90 * MINUTE),
  ];
}

/** Three S5 runs with a setup step 50 s longer than S6's, and one lost to the registry limit. */
const lean = { queue: 2000, prepare: 20000, server: 30000, after: 10000 };
const baseline = [
  ...[1, 2, 3].map((n) =>
    withSetupStep(
      makeRecord({
        label: 'baseline-b',
        id: 100 + n,
        start: n * 600000,
        shards: [
          { ...lean, setup: 150000, tests: [makeTest('t1', [10000]), makeTest('t2', [10000])] },
          { ...lean, setup: 150000, queue: 4000, tests: [makeTest('t3', [20000])] },
        ],
      })
    )
  ),
  makeRecord({
    label: 'baseline-b',
    id: 104,
    start: 4 * 600000,
    shards: [
      {
        ...lean,
        setup: 1000,
        stoppedAt: SETUP,
        failureNote: 'studio Error toomanyrequests: Data limit exceeded',
        tests: [makeTest('t1', [1000])],
      },
      { ...lean, setup: 1000, tests: [makeTest('t3', [1000])] },
    ],
  }),
];

const evidence = {
  rows: [
    {
      id: 'sim.couture-cast',
      facts: {
        overheadMs: { median: 150000 },
        byTest: [
          { shards: 2, builtinMs: 20000, balancedMs: 15000, elapsedMs: 165000, machineMs: 340000 },
          { shards: 3, builtinMs: 12000, balancedMs: 10000, elapsedMs: 160000, machineMs: 490000 },
        ],
      },
    },
  ],
};

const doc = (records = dataset()) => render({ records, baseline, evidence });
const section = (text, heading) => text.split(heading)[1].split('\n## ')[0];

/** The merge job finished 50 s earlier: the run completes 50 s sooner. */
function shorten(job) {
  const done = new Date(Date.parse(job.completedAt) - 50000).toISOString().replace('.000Z', 'Z');
  return { ...job, completedAt: done };
}

/** Records analyzed the way the renderer analyzes them, for correctnessOf. */
function analyzed(records) {
  const byId = new Map(records.map((r) => [r.run.id, r]));
  const runs = records.map((r) => ({
    ...analyzeRun(r),
    comparison: r.comparison || null,
    phase: r.arm.phase,
  }));
  return { runs, byId, cfg: configOf(records) };
}

test('renders every section from the records', () => {
  const text = doc();
  for (const heading of [
    '## Arms',
    '## Measured runs',
    '### Pairs',
    '## Warm-up runs',
    '### Engine plan lines',
    '## Completion against the control',
    '## Cost and where the time went',
    '## Correctness',
    '### Tolerance',
    '## Model against measurement',
    '## Setup before and after step 0',
    '## What this means for S7',
    '## Method',
  ]) {
    assert.ok(text.includes(heading), heading);
  }
});

test('the completion table pairs each arm with its own control runs and gives an interval', () => {
  const text = doc();
  // control 257 s, three shards of one 10 s test 245 s, in both pairs
  assert.match(
    text,
    /\| `shards-3` \| 2 \| 0 \/ 2 and 0 \/ 2 \| 257\.0 s \| 245\.0 s \| -12\.0 s \(-4\.7%\) \| -12\.0 s \| -12\.0 s to -12\.0 s \(50\.0%\) \| 2 of 2 \| 1 of 2 \| 600\.0 s \| faster \|/
  );
  assert.match(
    text,
    /\| `flakiness` \| 2 \| 0 \/ 2 and 0 \/ 2 \| 257\.0 s \| 257\.0 s \| \+0\.0 s \(\+0\.0%\) \| \+0\.0 s \| \+0\.0 s to \+0\.0 s \(50\.0%\) \| 0 of 2 \| 1 of 2 \| 600\.0 s \| no detectable difference \|/
  );
});

test('the S7 section states each verdict, the machine time and the provisional gate', () => {
  const text = section(doc(), '## What this means for S7');
  assert.match(
    text,
    /- `shards-3` beats the control on completion: median change within a pair -12\.0 s/
  );
  assert.match(text, /Machine time moves \+150\.0 s within a pair \(\+41\.7% on the medians\)\./);
  assert.match(text, /- `flakiness` shows no detectable difference from the control on completion/);
  assert.match(text, /the change of the medians is below the line/);
  assert.doesNotMatch(text, /above the line/);
  const quick = dataset().map((r) =>
    r.label === 'shards-3'
      ? { ...r, jobs: r.jobs.map((j) => (j.name === 'merge-reports' ? shorten(j) : j)) }
      : r
  );
  const bullet = section(doc(quick), '## What this means for S7')
    .split('\n- ')
    .find((b) => b.startsWith('`shards-3`'));
  assert.match(bullet, /-24\.1%[\s\S]*above the line/);
});

test('the warm-up runs stay out of the comparison and appear in their own table', () => {
  const text = doc();
  assert.match(section(text, '## Warm-up runs'), /\[90\]/);
  assert.doesNotMatch(section(text, '## Measured runs'), /\[90\]/);
});

test('every arm sees both orders inside its pairs', () => {
  const text = doc();
  const order = (id) =>
    text
      .split('\n')
      .find((line) => line.includes(`[${id}](`))
      .split('|')[6]
      .trim();
  assert.deepEqual(
    [order(1), order(2), order(5), order(6)],
    ['first', 'second', 'first', 'second']
  );
});

test('cache misses and other runs during a run are shown per run and per pair', () => {
  const text = doc();
  const row = text.split('\n').find((line) => line.startsWith('| `shards-3` | 1 | matched |'));
  assert.match(row, /\| 0 \/ 3 \|$/);
  const runRow = text.split('\n').find((line) => line.includes('[2](https://example.test/runs/2)'));
  assert.equal(runRow.split('|')[8].trim(), 'n/a');
  assert.equal(runRow.split('|')[9].trim(), '3');
});

test('the engine table reads real reporter durations and checks every shard printed the same plan', () => {
  const text = doc();
  assert.match(
    text,
    /\| `flakiness` \| \[3\]\(https:\/\/example\.test\/runs\/3\) \| 1 \| 3 \/ 3 \| 1=20\.0s, 2=20\.0s \| 100\.0% \| 76\.0 s \| 78\.0 s \| yes \|/
  );
  const records = dataset().map((r) => {
    if (r.run.id !== 8) return r;
    const lines = PLAN(2).map((l) => l.replace('1=20.0s, 2=20.0s', '1=30.0s, 2=10.0s'));
    return {
      ...r,
      jobs: r.jobs.map((j) => (j.name === 'pw-e2e (2, 2)' ? { ...j, engineLines: lines } : j)),
    };
  });
  const changed = doc(records);
  assert.match(changed, /\| `flakiness` \| \[8\][^\n]*\| no \|/);
  assert.match(
    section(changed, '## Correctness'),
    /`flakiness`[^\n]*regression: 1 run\(s\) did not balance on every shard/
  );
});

test('the cost table compares within pairs, and an arm step the control lacks is listed', () => {
  const text = doc();
  assert.match(
    text,
    /\| `shards-3` \| Machine time \(sum of shard jobs\) \| 360\.0 s \| 510\.0 s \| \+150\.0 s \| \+41\.7% \| \+150\.0 s \|/
  );
  assert.match(
    text,
    /\| `shards-3` \| Slowest shard job after its setup steps \| 80\.0 s \| 70\.0 s \|/
  );
  assert.match(text, /No arm adds a step to the shard jobs\./);
  const extra = dataset().map((r) => {
    if (r.label !== 'shards-3') return r;
    return {
      ...r,
      jobs: r.jobs.map((j) =>
        /^pw-e2e/.test(j.name)
          ? { ...j, steps: [...j.steps, { ...j.steps[2], name: 'Upload timings', number: 9 }] }
          : j
      ),
    };
  });
  assert.match(doc(extra), /\| `shards-3` \| Upload timings \| 10\.0 s \|/);
});

test('a two-worker arm is analyzed per worker and has no model row', () => {
  const text = doc();
  assert.match(
    text,
    /\| `workers-2` \| 2 \| 2 \| the model has one worker per shard, the arm 2 \|/
  );
  assert.match(
    text,
    /\| `workers-2` \| Slowest shard, time in tests per worker \| 20\.0 s \| 10\.0 s \|/
  );
});

test('the model distinguishes the built-in split from the balanced plan and rebuilds it from the S6 overhead', () => {
  const text = section(doc(), '## Model against measurement');
  // control: S4b overhead 150 s; S6 overhead is the 180 s job minus its 50 s Playwright run
  assert.match(
    text,
    /\| `control` \| 2 \| 1 \| 20\.0 s \(built-in split\) \| 20\.0 s \(\+0\.0%\) \| 150\.0 s \/ 130\.0 s \| 170\.0 s \| 150\.0 s \| 180\.0 s \(\+20\.0%\) \| 340\.0 s \/ 300\.0 s \| 360\.0 s \(\+20\.0%\) \|/
  );
  assert.match(
    text,
    /\| `flakiness` \| 2 \| 1 \| 15\.0 s \(balanced by test\) \| 20\.0 s \(\+33\.3%\) \|/
  );
  assert.match(
    text,
    /\| `shards-3` \| 3 \| 1 \| 12\.0 s \(built-in split\) \| 10\.0 s \(-16\.7%\) \|/
  );
});

test('the setup table compares S5 with the S6 control and counts runs lost to the registry', () => {
  const text = section(doc(), '## Setup before and after step 0');
  assert.match(text, /\| Playwright \| 1\.0\.0 \| 1\.0\.0 \| n\/a \| n\/a \|/);
  assert.match(
    text,
    /\| "Start local Supabase services" step, every shard job \| 150\.0 s \| 100\.0 s \| -50\.0 s \| -33\.3% \|/
  );
  assert.match(
    text,
    /\| Runs lost to `toomanyrequests` \/ runs \| 1 \/ 4 \| 0 \/ 5 \| n\/a \| n\/a \|/
  );
  assert.match(doc(), /Against S5 it moved -50\.0 s\./);
});

test('one arm-only failure is inconclusive, the same test bad twice is a regression', () => {
  const once = dataset().map((r) =>
    r.run.id === 5 ? threeShards(5, 2, 40 * MINUTE, { failed: true }) : r
  );
  const a = analyzed(once);
  const c = correctnessOf('shards-3', a.runs, a.cfg, a.byId);
  assert.equal(c.verdict, 'inconclusive');
  assert.deepEqual(c.once, ['chromium › t3.spec.ts › Suite › t3']);
  const twice = once.map((r) =>
    r.run.id === 2 ? threeShards(2, 1, 10 * MINUTE, { flaky: true }) : r
  );
  const b = analyzed(twice);
  const d = correctnessOf('shards-3', b.runs, b.cfg, b.byId);
  assert.equal(d.verdict, 'regression');
  assert.match(d.reasons.join(), /went bad in two or more arm runs and in no control run/);
  assert.match(section(doc(twice), '## Correctness'), /`chromium › t3\.spec\.ts › Suite › t3`/);
});

test('a test that is also bad in the control does not count against the arm', () => {
  const records = dataset().map((r) => {
    if (r.run.id === 5) return threeShards(5, 2, 40 * MINUTE, { failed: true });
    if (r.run.id === 2) return threeShards(2, 1, 10 * MINUTE, { failed: true });
    return r;
  });
  records.push(
    armRecord(
      withSetupStep(
        makeRecord({
          label: 'control',
          id: 11,
          pair: 3,
          start: 100 * MINUTE,
          shards: [
            { ...base, tests: [makeTest('t1', [10000]), makeTest('t2', [10000])] },
            { ...base, tests: [makeTest('t3', [5000, 5000, 5000], { status: 'failed' })] },
          ],
        })
      ),
      { comparison: 'shards-3' }
    )
  );
  const a = analyzed(records);
  const c = correctnessOf('shards-3', a.runs, a.cfg, a.byId);
  assert.deepEqual(c.repeated, []);
  assert.deepEqual(c.once, []);
});

test('an arm run that lists other tests than the control is a regression', () => {
  const records = dataset().map((r) => {
    if (r.run.id !== 5) return r;
    const lost = threeShards(5, 2, 40 * MINUTE);
    lost.shards[2].blob.tests[0] = { ...lost.shards[2].blob.tests[0], title: 'renamed' };
    return lost;
  });
  const a = analyzed(records);
  assert.match(
    correctnessOf('shards-3', a.runs, a.cfg, a.byId).reasons.join(),
    /another set of tests/
  );
});

test('more runs with a bad test than the control is a regression by the Fisher test', () => {
  const records = dataset();
  for (let pair = 3; pair <= 6; pair += 1) {
    records.push(control(200 + pair, pair, 'shards-3', (100 + pair * 20) * MINUTE));
    const flaky = threeShards(300 + pair, pair, (110 + pair * 20) * MINUTE);
    const extra = makeTest(`only${pair}`, [5000, 5000]);
    flaky.shards[0].blob.tests.push(extra);
    records.push(flaky);
  }
  const a = analyzed(records);
  const c = correctnessOf('shards-3', a.runs, a.cfg, a.byId);
  assert.equal(c.badRuns, 4);
  assert.ok(c.p < 0.05);
  assert.match(c.reasons.join(), /more runs with a bad test than the control/);
});

test('a run lost inside its tests is listed, never replaced, and breaks its pair', () => {
  const lost = threeShards(12, 3, 100 * MINUTE);
  lost.shards[0].blob = null;
  lost.shards[0].blobMissing = 'no blob artifact was uploaded';
  const text = doc([...dataset(), control(13, 3, 'shards-3', 95 * MINUTE), lost]);
  assert.match(
    text,
    /shard 1: no blob artifact was uploaded; counts against its label and is never replaced/
  );
  assert.match(text, /\| `shards-3` \| 3 \| broken \|/);
  assert.match(text, /\| `shards-3` \| 2 \| 1 \/ 3 and 0 \/ 3 \|/);
});

test('a run stopped before its tests names its replacement', () => {
  const stopped = control(14, 1, 'shards-3', -5 * MINUTE);
  stopped.jobs = stopped.jobs.map((j) =>
    j.name === 'pw-e2e (1, 2)'
      ? {
          ...j,
          steps: [{ ...j.steps[0], conclusion: 'cancelled' }],
          failureNote: 'kong Error toomanyrequests',
        }
      : j
  );
  assert.match(
    doc([...dataset(), stopped]),
    /stopped at "Start local Supabase services" \(cancelled\): kong Error toomanyrequests; replaced by 1/
  );
});

test('a pair whose halves ran far apart is stale and compares nothing', () => {
  const records = dataset().map((r) =>
    r.run.id === 6 ? control(6, 2, 'shards-3', 200 * MINUTE) : r
  );
  const text = doc(records);
  assert.match(text, /\| `shards-3` \| 2 \| stale \|/);
  assert.match(text, /\| `shards-3` \| 1 \| 0 \/ 2 and 0 \/ 2 \|/);
});

test('a tolerance phase reports interference from a test that failed only under stress', () => {
  const stress = armRecord(
    withSetupStep(
      makeRecord({
        label: 'workers-2-stress',
        id: 50,
        start: 300 * MINUTE,
        shards: [
          { ...base, tests: [makeTest('t1', [5000, 5000, 5000], { status: 'failed' })] },
          { ...base, tests: [makeTest('t3', [10000])] },
        ],
      })
    ),
    { phase: 'tolerance', workers: 2, stressOf: 'workers-2' }
  );
  const text = doc([...dataset(), stress]);
  assert.match(
    text,
    /\| `workers-2-stress` \| `workers-2` \| 1 \| 0 \| `chromium › t1\.spec\.ts › Suite › t1` \| none \| interference \|/
  );
  assert.match(text, /Its tolerance phase `workers-2-stress` \(1 runs\) reads: interference\./);
});

test('the Method counts the runs that overlapped another run of the repository', () => {
  const records = dataset().map((r, i) => ({
    ...r,
    dispatch: { overlapping: i === 1 ? [{ id: 1, workflow: 'x', createdAt: 'y' }] : [] },
  }));
  assert.match(doc(records), /1 of 11 runs with that record overlapped another run/);
});

test('the renderer refuses a mixed base, a duplicate run, a second control and missing inputs', () => {
  const mixed = dataset();
  mixed[1] = { ...mixed[1], base: { ...mixed[1].base, sha: 'd'.repeat(40) } };
  assert.throws(() => doc(mixed), /different target/);
  assert.throws(() => doc([...dataset(), dataset()[1]]), /two records/);
  const wrong = dataset();
  wrong[2] = { ...wrong[2], comparison: 'flakiness' };
  assert.throws(() => doc(wrong), /expected one control label, found 2/);
  assert.throws(() => render({ records: dataset(), baseline: [], evidence }), /no baseline record/);
  assert.throws(
    () => render({ records: dataset(), baseline, evidence: { rows: [] } }),
    /sim\.couture-cast/
  );
});

test('parseDuration reads every form the Flakiness reporter prints', () => {
  assert.equal(parseDuration('850ms'), 850);
  assert.equal(parseDuration('61.2s'), 61200);
  assert.equal(parseDuration('1m 16s'), 76000);
  assert.equal(parseDuration('1h 02m'), 3720000);
  assert.throws(() => parseDuration('soon'), /not a Flakiness duration/);
});

test('parseEngine reads the plan lines, a shard without a prediction, and refuses a garbled line', () => {
  assert.deepEqual(parseEngine(PLAN(2)), {
    hinted: 3,
    planned: 3,
    balance: 1,
    loads: '1=20.0s, 2=20.0s',
    predictedMs: 76000,
    actualMs: 78000,
  });
  const cold = parseEngine([
    '[flakiness.io] Shard 1/2 finished: 850ms of work (no prediction to compare against)',
  ]);
  assert.equal(cold.actualMs, 850);
  assert.equal(cold.predictedMs, null);
  assert.equal(parseEngine(null), null);
  assert.throws(() => parseEngine(['[flakiness.io] Shard 1/2 finished: whatever']), /unreadable/);
});

test('engineCheck wants the same plan line on every shard', () => {
  const record = flakiness(3, 1, 0);
  assert.equal(engineCheck(record).balanced, true);
  const missing = {
    ...record,
    jobs: record.jobs.map((j) => (j.name === 'pw-e2e (2, 2)' ? { ...j, engineLines: null } : j)),
  };
  assert.equal(engineCheck(missing).balanced, false);
});
