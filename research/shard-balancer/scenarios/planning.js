'use strict';

/**
 * The estimates and the model behind the plan: the price of a new test (row `e.hierarchy`), the
 * workers the plan packs for (row `w.plan-workers`) and `simulate` (rows `sim.*`), on the fixture
 * and on the couture-cast suite of the S5 baseline.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { analyzeRun } = require('../../../measurements/analyze');
const { median: statsMedian } = require('../../../measurements/stats');
const drive = require('../drive');
const { ROOT } = require('../upstream');
const { median } = require('./history');
const { row } = require('./row');

const SEP = ' › ';
const RAW = path.resolve(__dirname, '..', '..', '..', 'docs', 'measurements', 'raw');
const COUTURE_LABEL = 'baseline-b';
const SIM_SHARDS = '2-8';
const PREDICTION_TOLERANCE = 0.2;
const COUTURE_TOLERANCE = 0.2;

/** Our own computation of the estimate hierarchy: describe, file, project, suite medians. */
function ourEstimate(timings, { key, project, file }) {
  const values = Object.entries(timings.tests).map(([k, entry]) => [k, median(entry.samples)]);
  const known = new Map(values);
  if (known.has(key)) return { level: 'known', ms: known.get(key) };
  const fileScope = `[${project}]${SEP}${file}`;
  const parent = key.slice(0, key.lastIndexOf(SEP));
  const pick = (filter) => values.filter(([k]) => filter(k)).map(([, v]) => v);
  const levels = [
    [
      'describe',
      parent !== fileScope ? pick((k) => k.slice(0, k.lastIndexOf(SEP)) === parent) : [],
    ],
    ['file', pick((k) => k.startsWith(`${fileScope}${SEP}`))],
    ['project', pick((k) => k.startsWith(`[${project}]${SEP}`))],
    ['suite', values.map(([, v]) => v)],
  ];
  for (const [level, found] of levels) {
    if (found.length > 0) return { level, ms: median(found) };
  }
  return { level: 'none', ms: 1 };
}

async function hierarchy(ctx) {
  const { createEstimator } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'estimate.js')).href
  );
  const timings = drive.readTimings(ctx.baseline().timings);
  const estimator = createEstimator(timings);
  const cases = [
    {
      name: 'known test',
      project: 'chromium',
      file: 'cart.spec.js',
      titles: ['cart', 'adds an item'],
    },
    {
      name: 'new test in a known describe',
      project: 'chromium',
      file: 'cart.spec.js',
      titles: ['cart', 'a new test'],
    },
    {
      name: 'new test outside the describes of a known file',
      project: 'chromium',
      file: 'cart.spec.js',
      titles: ['a new test'],
    },
    {
      name: 'new file in a known project',
      project: 'chromium',
      file: 'new.spec.js',
      titles: ['a new test'],
    },
    {
      name: 'new project',
      project: 'webkit',
      file: 'cart.spec.js',
      titles: ['cart', 'adds an item'],
    },
  ].map((test) => {
    const key = [`[${test.project}]`, test.file, ...test.titles].join(SEP);
    const input = { key, project: test.project, file: test.file, staticSkip: false };
    const ours = ourEstimate(timings, input);
    return {
      name: test.name,
      level: ours.level,
      packageMs: estimator.estimate(input),
      oursMs: ours.ms,
    };
  });
  const skipped = estimator.estimate({
    key: 'x',
    project: 'chromium',
    file: 'cart.spec.js',
    staticSkip: true,
  });
  const facts = {
    cases,
    levels: cases.map((c) => c.level),
    agree: cases.every((c) => c.packageMs === c.oursMs),
    staticSkipMs: skipped,
  };
  return row(
    'e.hierarchy',
    'A new test is priced at the median of its describe, else its file, else its project, else the whole suite, and a test skipped before it runs costs nothing.',
    facts.agree && skipped === 0 && facts.levels.join() === 'known,describe,file,project,suite',
    facts,
    `The package's estimator, run on the fixture history, gives ${cases.map((c) => `${c.packageMs} ms (${c.level})`).join(', ')}; our own medians give the same (${facts.agree}). A static skip costs ${skipped} ms.`
  );
}

/** Mean relative error of the prediction of each shard against its measured test time. */
function predictionError(run) {
  const errors = run.records.map((r) => {
    const { predicted_ms: predicted, tests_ms: actual, shard } = r.data;
    return Math.abs(predicted[shard.current - 1] - actual) / actual;
  });
  return Number((errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(3));
}

function planWorkers(ctx) {
  const timings = ctx.baseline().timings;
  const runs = [1, 2].map((planWorkers) =>
    ctx.run({ name: `plan-workers-${planWorkers}`, shards: 3, timings, workers: 2, planWorkers })
  );
  const facts = {
    harnessOk: runs.map((run) => run.summary.ok),
    predictedMs: runs.map((run) => run.records[0].data.predicted_ms),
    testsMs: runs.map((run) => run.records.map((r) => r.data.tests_ms)),
    errorPlanWorkers1: predictionError(runs[0]),
    errorPlanWorkers2: predictionError(runs[1]),
  };
  return row(
    'w.plan-workers',
    'A plan packed for the workers a shard runs predicts its time better than a plan packed for one worker.',
    facts.harnessOk.every(Boolean) && facts.errorPlanWorkers2 < facts.errorPlanWorkers1,
    facts,
    `Three shards under \`--workers=2\`: the plan for one worker predicted ${facts.predictedMs[0].join(' / ')} ms and missed the measured ${facts.testsMs[0].join(' / ')} ms by ${(facts.errorPlanWorkers1 * 100).toFixed(1)}% on average; the plan for two workers predicted ${facts.predictedMs[1].join(' / ')} ms against ${facts.testsMs[1].join(' / ')} ms, off by ${(facts.errorPlanWorkers2 * 100).toFixed(1)}%.`
  );
}

/** The fixture's JSON list, the input of `simulate`. */
function fixtureList(ctx) {
  return ctx.once('fixture-list', () =>
    drive.listReport({
      cwd: ctx.cwd,
      config: ctx.config(),
      file: path.join(ctx.dir('list'), 'list.json'),
    })
  );
}

function simulateOk(call) {
  if (call.status !== 0 || !call.json) throw new Error(`simulate failed: ${call.stderr}`);
  return call.json;
}

function predictedVsActual(ctx) {
  const timings = ctx.baseline().timings;
  const sim = simulateOk(
    drive.simulate({ timings, list: fixtureList(ctx), shards: '2-3', workers: 1 })
  );
  const builtin3 = ctx.run({ name: 'builtin-3-w1', shards: 3, workers: 1 });
  const measured = {
    2: { builtin: ctx.baseline().records, balanced: ctx.balanced(2).records },
    3: { builtin: builtin3.records, balanced: ctx.balanced(3).records },
  };
  const slowest = (records) => Math.max(...records.map((r) => r.data.tests_ms));
  const rows = sim.rows.map((r) => {
    const builtinMs = slowest(measured[r.shards].builtin);
    const balancedMs = slowest(measured[r.shards].balanced);
    return {
      shards: r.shards,
      simulatedBuiltinMs: r.builtin_ms,
      measuredBuiltinMs: builtinMs,
      simulatedBalancedMs: r.balanced_ms,
      measuredBalancedMs: balancedMs,
      builtinError: Number((Math.abs(r.builtin_ms - builtinMs) / builtinMs).toFixed(3)),
      balancedError: Number((Math.abs(r.balanced_ms - balancedMs) / balancedMs).toFixed(3)),
    };
  });
  const facts = { rows, tolerance: PREDICTION_TOLERANCE };
  return row(
    'sim.predicted-vs-actual',
    `\`simulate\` predicts the slowest shard of the fixture within ${PREDICTION_TOLERANCE * 100}%, with the built-in split and balanced.`,
    rows.every(
      (r) => r.builtinError <= PREDICTION_TOLERANCE && r.balancedError <= PREDICTION_TOLERANCE
    ),
    facts,
    rows
      .map(
        (r) =>
          `${r.shards} shards: built-in ${r.simulatedBuiltinMs} ms simulated against ${r.measuredBuiltinMs} ms measured, balanced ${r.simulatedBalancedMs} ms against ${r.measuredBalancedMs} ms.`
      )
      .join(' ')
  );
}

function overhead(ctx) {
  const timings = ctx.baseline().timings;
  const list = fixtureList(ctx);
  const plain = simulateOk(drive.simulate({ timings, list, shards: 3, workers: 1 })).rows[0];
  const withOverhead = simulateOk(
    drive.simulate({ timings, list, shards: 3, workers: 1, overhead: '90s' })
  ).rows[0];
  const facts = {
    elapsedMs: plain.elapsed_ms,
    elapsedWithOverheadMs: withOverhead.elapsed_ms,
    machineMs: plain.machine_ms,
    machineWithOverheadMs: withOverhead.machine_ms,
    balancedMs: withOverhead.balanced_ms,
  };
  return row(
    'sim.overhead',
    '`--overhead` adds a fixed cost per shard: once to the elapsed time and once per shard to the machine time, leaving the plan alone.',
    facts.elapsedWithOverheadMs - facts.elapsedMs === 90000 &&
      facts.machineWithOverheadMs - facts.machineMs === 3 * 90000 &&
      plain.balanced_ms === withOverhead.balanced_ms,
    facts,
    `Three shards with \`--overhead 90s\`: elapsed ${facts.elapsedMs} ms becomes ${facts.elapsedWithOverheadMs} ms and machine time ${facts.machineMs} ms becomes ${facts.machineWithOverheadMs} ms; the balanced slowest shard stays ${facts.balancedMs} ms.`
  );
}

/** The S5 records of `label` whose every shard has a blob report, oldest first. */
function coutureRecords(label = COUTURE_LABEL) {
  return fs
    .readdirSync(RAW)
    .filter((file) => file.startsWith(`${label}-`) && file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8')))
    .filter((record) => record.shards.every((shard) => shard.blob))
    .sort((a, b) => Date.parse(a.run.createdAt) - Date.parse(b.run.createdAt));
}

const testKeyOf = (test) =>
  [`[${test.project}]`, test.file, ...test.titlePath.slice(1), test.title].join(SEP);

/**
 * A Playwright JSON list of the couture-cast suite, built from the blob tests of one S5 run in the
 * order its shards ran them (Playwright's load order, since each shard ran one worker), with the
 * serial annotation on the tests of each serial suite, as Playwright 1.63+ writes it.
 */
function coutureList(record) {
  const files = new Map();
  const serialLine = new Map(
    record.serialSuites.map((s, i) => [`${s.file}\0${s.suite}`, 10000 + i])
  );
  let line = 0;
  for (const shard of record.shards) {
    for (const test of shard.blob.tests) {
      if (!files.has(test.file))
        files.set(test.file, { title: test.file, file: test.file, specs: [], suites: [] });
      let suite = files.get(test.file);
      for (const title of test.titlePath.slice(1)) {
        let child = suite.suites.find((s) => s.title === title);
        if (!child) suite.suites.push((child = { title, file: test.file, specs: [], suites: [] }));
        suite = child;
      }
      const serial = record.serialSuites.find(
        (s) => s.file === test.file && test.titlePath.includes(s.suite)
      );
      line += 1;
      suite.specs.push({
        title: test.title,
        file: test.file,
        line,
        column: 1,
        tests: [
          {
            projectName: test.project,
            status: 'expected',
            expectedStatus: test.expectedStatus,
            results: [],
            annotations: serial
              ? [
                  {
                    type: 'serial',
                    location: {
                      line: serialLine.get(`${serial.file}\0${serial.suite}`),
                      column: 1,
                    },
                  },
                ]
              : [],
          },
        ],
      });
    }
  }
  const projects = record.shards[0].blob.projects.map((p) => ({
    name: p.name,
    dependencies: p.dependencies || [],
  }));
  return {
    config: {
      version: record.shards[0].blob.playwrightVersion,
      fullyParallel: record.facts.fullyParallel,
      projects,
      filteredProjects: projects,
    },
    suites: [...files.values()],
    errors: [],
  };
}

/** Timings of the couture-cast suite: one sample per run for every test that passed in it. */
function coutureTimings(records) {
  const tests = {};
  for (const record of records) {
    const seen = record.run.createdAt.slice(0, 10);
    for (const shard of record.shards) {
      for (const test of shard.blob.tests) {
        const last = test.attempts[test.attempts.length - 1];
        if (!last || last.status !== test.expectedStatus || last.status !== 'passed') continue;
        const key = testKeyOf(test);
        const entry = (tests[key] ??= { samples: [], seen });
        entry.samples.push(Math.round(test.attempts.reduce((sum, a) => sum + a.duration, 0)));
        entry.samples = entry.samples.slice(-5);
        entry.seen = seen;
      }
    }
  }
  return { version: 1, tests };
}

const seconds = (ms) => Math.round(ms / 1000);

function coutureCast(ctx) {
  const records = coutureRecords();
  const dir = ctx.dir('couture-cast');
  const list = path.join(dir, 'list.json');
  const timings = path.join(dir, 'timings.json');
  fs.writeFileSync(list, JSON.stringify(coutureList(records[0])));
  fs.writeFileSync(timings, JSON.stringify(coutureTimings(records)));

  const analyzed = records.map(analyzeRun);
  const overheads = records.flatMap((record, i) =>
    record.shards.map((shard) => {
      const job = analyzed[i].shards.find((s) => s.index === shard.index);
      return Math.round(job.jobMs - shard.blob.run.duration);
    })
  );
  const overheadMs = {
    median: statsMedian(overheads),
    min: Math.min(...overheads),
    max: Math.max(...overheads),
  };
  const measuredSlowestMs = statsMedian(analyzed.map((run) => run.balance.slowestBusy));
  const measuredBoundMs = statsMedian(analyzed.map((run) => run.balance.lowerBound));
  const byTest = simulateOk(
    drive.simulate({
      timings,
      list,
      shards: SIM_SHARDS,
      workers: 1,
      overhead: `${seconds(overheadMs.median)}s`,
    })
  );
  const byFile = simulateOk(
    drive.simulate({
      timings,
      list,
      shards: SIM_SHARDS,
      workers: 1,
      granularity: 'file',
      overhead: `${seconds(overheadMs.median)}s`,
    })
  );
  const pick = (r) => ({
    shards: r.shards,
    builtinMs: r.builtin_ms,
    balancedMs: r.balanced_ms,
    lowerBoundMs: r.lower_bound_ms,
    elapsedMs: r.elapsed_ms,
    machineMs: r.machine_ms,
  });
  const two = byTest.rows.find((r) => r.shards === 2);
  const builtinError = Math.abs(two.builtin_ms - measuredSlowestMs) / measuredSlowestMs;
  const facts = {
    runs: records.length,
    tests: byTest.tests,
    unknownTests: byTest.unknown_tests,
    granularity: byTest.granularity,
    overheadMs,
    overheadInput: `${seconds(overheadMs.median)}s`,
    measuredSlowestMs: Math.round(measuredSlowestMs),
    measuredBoundMs: Math.round(measuredBoundMs),
    builtinError: Number(builtinError.toFixed(3)),
    tolerance: COUTURE_TOLERANCE,
    byTest: byTest.rows.map(pick),
    byFile: byFile.rows.map(pick),
  };
  return row(
    'sim.couture-cast',
    `\`simulate\` over a list and timings built from the S5 runs models couture-cast's measured two-shard split within ${COUTURE_TOLERANCE * 100}%.`,
    builtinError <= COUTURE_TOLERANCE && facts.unknownTests === 0,
    facts,
    `From ${facts.runs} runs of \`${COUTURE_LABEL}\` (${facts.tests} tests): the built-in split of two shards simulates at ${two.builtin_ms} ms against a measured median slowest shard of ${facts.measuredSlowestMs} ms in tests, and balancing at ${two.balanced_ms} ms against the S5 bound of ${facts.measuredBoundMs} ms. The per-shard overhead outside the Playwright run is ${seconds(overheadMs.median)} s median (${seconds(overheadMs.min)} to ${seconds(overheadMs.max)} s).`
  );
}

async function planningRows(ctx) {
  return [
    await hierarchy(ctx),
    planWorkers(ctx),
    predictedVsActual(ctx),
    overhead(ctx),
    coutureCast(ctx),
  ];
}

module.exports = { coutureList, coutureRecords, coutureTimings, ourEstimate, planningRows };
