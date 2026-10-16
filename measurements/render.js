'use strict';

/**
 * Renders `docs/measurements/baseline.md` from raw run records. The document is generated whole:
 * its prose carries no figure, and every figure comes from the records. Usage:
 *
 *   node measurements/render.js --raw docs/measurements/raw --out docs/measurements/baseline.md
 */

const fs = require('node:fs');
const path = require('node:path');
const { percent, signedPercent, table } = require('../qualification/lib/tables');
const { BOUND_SHARDS, analyzeLabel, analyzeRun, compareLabels } = require('./analyze');
const { median } = require('./stats');

const sec = (value) => `${(value / 1000).toFixed(1)} s`;
const secSigned = (value) => `${value >= 0 ? '+' : '-'}${(Math.abs(value) / 1000).toFixed(1)} s`;
const ratio = (value) => `${value.toFixed(2)}x`;
const uniq = (values) => [...new Set(values)].sort();
const joined = (values) => uniq(values).join(', ');

/** The record of the run created first. */
function earliest(records) {
  return records.reduce((a, b) =>
    Date.parse(b.run.createdAt) < Date.parse(a.run.createdAt) ? b : a
  );
}

/** Records of one document share their target; mixing targets or reusing a run would mislead. */
function assertConsistent(records) {
  const first = records[0];
  const same = (record) =>
    JSON.stringify([
      record.repo,
      record.workflow,
      record.testStep,
      record.facts,
      record.serialSuites,
    ]);
  for (const record of records) {
    if (same(record) !== same(first)) {
      throw new Error(`run ${record.run.id} measures a different target than run ${first.run.id}`);
    }
  }
  const ids = records.map((r) => r.run.id);
  if (new Set(ids).size !== ids.length) throw new Error('a run appears in two records');
  const slots = records.map((r) => `${r.label}/${r.pair}`);
  if (new Set(slots).size !== slots.length) throw new Error('a label has two runs in one pair');
}

function loadRecords(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

/** Runs of one label in the order they were dispatched. */
function runsOf(analyzed, label) {
  return analyzed.filter((run) => run.label === label).sort((a, b) => a.createdAt - b.createdAt);
}

function summaryRow(name, label, stat, format) {
  return [
    name,
    label,
    format(stat.median),
    format(stat.min),
    format(stat.max),
    percent(stat.spread),
  ];
}

function renderShape(records, labels) {
  const of = (label) => records.filter((record) => record.label === label);
  const shards = (label) => of(label).flatMap((record) => record.shards.filter((s) => s.blob));
  const first = earliest(records);
  const rows = [
    [
      'Repository',
      `[${first.repo.owner}/${first.repo.name}](https://github.com/${first.repo.owner}/${first.repo.name})`,
    ],
    [
      'Workflow',
      `\`${first.workflow}\`, started with \`${joined(records.map((r) => r.run.event))}\``,
    ],
    ['Concurrency', first.facts.concurrency],
    ['Command', `\`${first.facts.command}\``],
    ['`fullyParallel`', String(first.facts.fullyParallel)],
    ['Shards', joined(records.map((r) => r.shards.length))],
    [
      'Workers per shard',
      joined(records.flatMap((r) => r.shards.filter((s) => s.blob).map((s) => s.blob.workers))),
    ],
    [
      'Retries',
      joined(
        records.flatMap((r) =>
          r.shards.filter((s) => s.blob).flatMap((s) => s.blob.projects.map((p) => p.retries))
        )
      ),
    ],
    [
      'Projects',
      joined(
        records.flatMap((r) =>
          r.shards.filter((s) => s.blob).flatMap((s) => s.blob.projects.map((p) => p.name))
        )
      ),
    ],
    [
      'Runner',
      `${joined(records.flatMap((r) => r.jobs.map((j) => j.labels.join('+'))).filter(Boolean))}, runner group ${joined(records.flatMap((r) => r.jobs.map((j) => j.runnerGroup)).filter(Boolean))}, ${joined(records.flatMap((r) => r.jobs.map((j) => j.runner && j.runner.image && `${j.runner.image} ${j.runner.imageVersion}`)).filter(Boolean))}`,
    ],
    [
      'Runner regions',
      joined(
        records.flatMap((r) => r.jobs.map((j) => j.runner && j.runner.region)).filter(Boolean)
      ),
    ],
    [
      'Jobs that ran',
      joined(
        records.flatMap((r) =>
          r.jobs
            .filter((j) => j.conclusion !== 'skipped')
            .map((j) => j.name.replace(/ \(\d+, \d+\)$/, ''))
        )
      ),
    ],
  ];
  for (const label of labels) {
    rows.push(
      [`What \`${label}\` is`, joined(of(label).map((r) => r.labelNote))],
      [`Branch of \`${label}\``, joined(of(label).map((r) => r.run.branch))],
      [`Commit of \`${label}\``, joined(of(label).map((r) => r.run.sha.slice(0, 12)))],
      [`Playwright of \`${label}\``, joined(shards(label).map((s) => s.blob.playwrightVersion))],
      [`Node of \`${label}\``, joined(shards(label).map((s) => s.blob.node))]
    );
  }
  return table(['Property', 'Value'], rows);
}

function renderSuite(records) {
  const complete = records.filter((r) => r.shards.every((s) => s.blob));
  const record = earliest(complete);
  const shards = record.shards.filter((s) => s.blob);
  const tests = shards.flatMap((s) => s.blob.tests);
  const rows = record.serialSuites.map((serial) => {
    const members = tests.filter(
      (t) => t.file === serial.file && t.titlePath.includes(serial.suite)
    );
    return [
      `\`${serial.file}\``,
      serial.suite,
      String(members.length),
      sec(members.reduce((sum, t) => sum + t.attempts.reduce((x, a) => x + a.duration, 0), 0)),
    ];
  });
  return {
    count: tests.length,
    files: new Set(tests.map((t) => t.file)).size,
    serial: record.serialSuites.length,
    table: table(['File', 'Serial suite', 'Tests', 'Time in the earliest run'], rows),
  };
}

function renderRuns(analyzed, labels) {
  const rows = [];
  for (const label of labels) {
    runsOf(analyzed, label).forEach((run) => {
      const peers = analyzed.filter((other) => other.pair === run.pair && other.label !== label);
      const order =
        peers.length === 0
          ? 'n/a'
          : peers.every((peer) => run.createdAt < peer.createdAt)
            ? 'first'
            : 'second';
      const link = `[${run.id}](${run.url})`;
      const created = new Date(run.createdAt).toISOString().slice(0, 19).replace('T', ' ');
      if (run.excluded) {
        rows.push([
          label,
          String(run.pair),
          link,
          created,
          order,
          run.conclusion,
          '',
          '',
          '',
          '',
          '',
          '',
          run.excluded,
        ]);
        return;
      }
      rows.push([
        label,
        String(run.pair),
        link,
        created,
        order,
        run.conclusion,
        sec(run.queueCritical),
        sec(run.execution),
        sec(run.completion),
        run.shards.map((s) => (s.jobMs / 1000).toFixed(0)).join(' / '),
        sec(
          run.shards[run.criticalShard - 1].setupMs + run.shards[run.criticalShard - 1].prepareMs
        ),
        `${run.retries} / ${run.flaky} / ${run.failed}`,
        '',
      ]);
    });
  }
  return table(
    [
      'Label',
      'Pair',
      'Run',
      'Created (UTC)',
      'Order in pair',
      'Result',
      'Queue on critical path',
      'Execution',
      'Completion',
      'Shard jobs (s)',
      'Critical shard before tests',
      'Retries / flaky / failed',
      'Excluded from timings',
    ],
    rows
  );
}

function renderPassRates(summaries, analyzed) {
  return table(
    [
      'Label',
      'Runs',
      'Succeeded',
      'Pass rate',
      'With timings',
      'With timings and no failed test',
      'Without timings',
    ],
    summaries.map((s) => {
      const timed = runsOf(analyzed, s.label).filter((r) => !r.excluded);
      return [
        s.label,
        String(s.runs),
        String(s.succeeded),
        percent(s.succeeded / s.runs),
        String(s.timed),
        String(timed.filter((r) => r.failed === 0).length),
        s.excluded.length === 0 ? 'none' : s.excluded.map((e) => `${e.id}: ${e.why}`).join('; '),
      ];
    })
  );
}

function renderSummary(summaries) {
  const rows = [];
  const add = (name, key, format) => {
    for (const s of summaries) if (s[key]) rows.push(summaryRow(name, s.label, s[key], format));
  };
  add('Completion (created to last job done)', 'completion', sec);
  add('Queue delay on the critical path', 'queueCritical', sec);
  add('Execution (completion minus queue)', 'execution', sec);
  add('Slowest shard job', 'slowestJob', sec);
  add('Fastest shard job', 'fastestJob', sec);
  add('Slowest over fastest shard job', 'jobImbalance', ratio);
  add('Fixed cost (execution minus the critical shard test span)', 'fixed', sec);
  add('Runner time of all jobs', 'aggregateRunner', sec);
  return table(['Measure', 'Label', 'Median', 'Min', 'Max', 'Spread'], rows);
}

function renderDecomposition(analyzed, summaries) {
  const parts = [
    ['queue', 'Queue delay on the critical path'],
    ['fixed', "Fixed cost: every job and step outside the critical shard's test span"],
    ['share', 'Test time, ideal share (total test time over shards)'],
    ['atomicExcess', 'Test time, atomic group beyond the ideal share'],
    ['assignmentGap', 'Test time, critical shard above the lower bound (assignment)'],
    ['inTestOverhead', 'Test time, overhead between tests (not test bodies)'],
  ];
  const rows = [];
  for (const [key, name] of parts) {
    const cells = [name];
    for (const s of summaries) {
      const runs = runsOf(analyzed, s.label).filter((r) => !r.excluded);
      const shares = runs.map((r) => r.decomposition[key] / r.completion);
      cells.push(sec(s.decomposition[key]), percent(median(shares)));
    }
    rows.push(cells);
  }
  const header = ['Part of completion'];
  for (const s of summaries) header.push(`${s.label} median`, `${s.label} median per-run share`);
  return table(header, rows);
}

function renderVerdict(summaries, analyzed) {
  return summaries
    .filter((s) => s.timed > 0)
    .map((s) => {
      const d = s.decomposition;
      const runs = runsOf(analyzed, s.label).filter((r) => !r.excluded);
      const share = (key) => percent(median(runs.map((r) => r.decomposition[key] / r.completion)));
      return [
        `- \`${s.label}\`: the dominant delay is **${s.dominant}**.`,
        `  Median fixed cost: ${sec(d.fixed)}; median per-run share of completion: ${share('fixed')}. Median completion: ${sec(s.completion.median)}.`,
        `  Median assignment gap: ${sec(d.assignmentGap)}; median per-run share of completion: ${share('assignmentGap')}.`,
        `  Median excess of the largest atomic group over the ideal share: ${sec(d.atomicExcess)}; median per-run share of completion: ${share('atomicExcess')}.`,
        `  Each share is the median of the per-run ratios, so dividing one median by another gives a different figure.`,
        `  The fixed cost ranged over ${sec(s.fixed.max - s.fixed.min)} between runs, against a median balance headroom of ${sec(s.headroom.median)}.`,
      ].join('\n');
    })
    .join('\n');
}

function renderBalance(summaries) {
  const rows = [];
  const add = (name, key, format) => {
    for (const s of summaries) if (s[key]) rows.push(summaryRow(name, s.label, s[key], format));
  };
  add('Slowest shard, time spent in tests', 'slowestBusy', sec);
  add('Ideal-balance lower bound (same atomic groups)', 'lowerBound', sec);
  add('Longest-first packing of the same groups', 'packed', sec);
  add('Largest atomic group', 'largestUnit', sec);
  add('Headroom: slowest shard minus lower bound', 'headroom', sec);
  add('Slowest shard over the ideal share', 'busiestShare', ratio);
  return table(['Measure', 'Label', 'Median', 'Min', 'Max', 'Spread'], rows);
}

function renderBounds(analyzed, labels) {
  const rows = labels.map((label) => {
    const runs = runsOf(analyzed, label).filter((r) => !r.excluded);
    return [label, ...BOUND_SHARDS.map((n) => sec(median(runs.map((r) => r.balance.bounds[n]))))];
  });
  return table(['Label', ...BOUND_SHARDS.map((n) => `${n} shards`)], rows);
}

function renderShardPhases(analyzed, labels) {
  const rows = [];
  for (const label of labels) {
    const runs = runsOf(analyzed, label).filter((r) => !r.excluded);
    const count = runs[0].shards.length;
    if (runs.some((r) => r.shards.length !== count)) {
      throw new Error(`${label}: the shard count differs between runs`);
    }
    for (let index = 0; index < count; index += 1) {
      const at = (key) => median(runs.map((r) => r.shards[index][key]));
      rows.push([
        label,
        String(index + 1),
        sec(at('queueMs')),
        sec(at('setupMs')),
        sec(at('prepareMs')),
        sec(at('serverMs')),
        sec(at('spanMs')),
        sec(at('busy')),
        sec(at('afterMs')),
        sec(at('jobMs')),
        String(at('tests')),
      ]);
    }
  }
  return table(
    [
      'Label',
      'Shard',
      'Queue',
      'Setup steps',
      'Prepare in test step',
      'Server start and teardown',
      'Test span',
      'Time in tests',
      'Steps after tests',
      'Job',
      'Tests',
    ],
    rows
  );
}

function renderSteps(analyzed, labels) {
  const medians = new Map();
  for (const label of labels) {
    const perStep = new Map();
    for (const run of runsOf(analyzed, label).filter((r) => !r.excluded)) {
      for (const [key, values] of Object.entries(run.stepTimes)) {
        perStep.set(key, [...(perStep.get(key) || []), ...values]);
      }
    }
    medians.set(label, new Map([...perStep].map(([key, values]) => [key, median(values)])));
  }
  const keys = [];
  for (const label of labels)
    for (const key of medians.get(label).keys()) if (!keys.includes(key)) keys.push(key);
  const rows = keys
    .filter((key) => labels.some((label) => (medians.get(label).get(key) || 0) >= 1000))
    .map((key) => {
      const [job, step] = key.split('\u0000');
      return [
        job,
        step,
        ...labels.map((label) =>
          medians.get(label).has(key) ? sec(medians.get(label).get(key)) : 'n/a'
        ),
      ];
    });
  return table(['Job', 'Step', ...labels.map((label) => `${label} median`)], rows);
}

function renderUpgrade(analyzed, summaries, labels, records) {
  if (labels.length < 2) return 'Only one label has runs, so there is no upgrade comparison.';
  if (labels.length > 2) throw new Error('the upgrade control compares exactly two labels');
  const [a, b] = labels;
  const runsA = runsOf(analyzed, a);
  const runsB = runsOf(analyzed, b);
  const metrics = [
    ['Completion', (r) => r.completion, sec],
    ['Execution', (r) => r.execution, sec],
    ['Slowest shard job', (r) => r.slowestJobMs, sec],
    ['Fixed cost', (r) => r.decomposition.fixed, sec],
    ['Slowest shard time in tests', (r) => r.balance.slowestBusy, sec],
    ['Retries per run', (r) => r.retries, (v) => v.toFixed(1)],
  ];
  const rows = metrics.map(([name, fn, fmt]) => {
    const c = compareLabels(runsA, runsB, fn);
    return [
      name,
      fmt(c.medianA),
      fmt(c.medianB),
      name === 'Retries per run'
        ? (c.delta >= 0 ? '+' : '') + c.delta.toFixed(1)
        : secSigned(c.delta),
      Number.isFinite(c.ratio) ? signedPercent(c.ratio) : 'n/a',
      c.overlap ? 'yes' : 'no',
    ];
  });
  const sa = summaries.find((s) => s.label === a);
  const sb = summaries.find((s) => s.label === b);
  rows.push([
    'Pass rate',
    percent(sa.succeeded / sa.runs),
    percent(sb.succeeded / sb.runs),
    signedPercent(sb.succeeded / sb.runs - sa.succeeded / sa.runs),
    'n/a',
    'n/a',
  ]);
  const completion = compareLabels(runsA, runsB, (r) => r.completion);
  const version = (label) =>
    joined(
      records
        .filter((r) => r.label === label)
        .flatMap((r) => r.shards.filter((s) => s.blob).map((s) => s.blob.playwrightVersion))
    );
  const n = (runs) => runs.filter((r) => !r.excluded).length;
  const counts = `${n(runsA)} runs of \`${a}\` and ${n(runsB)} runs of \`${b}\` with timings`;
  const verdict = completion.overlap
    ? `With ${counts}, the completion ranges overlap. The median moves ${secSigned(completion.delta)} (${signedPercent(completion.ratio)}), which is inside the run-to-run spread, so no duration change from the upgrade is detectable.`
    : `With ${counts}, the completion ranges do not overlap. The median moves ${secSigned(completion.delta)} (${signedPercent(completion.ratio)}) with the upgrade.`;
  return [
    `\`${a}\` runs Playwright ${version(a)} and \`${b}\` runs Playwright ${version(b)}. What each label changes is in the shape table.`,
    '',
    table(['Measure', `${a} median`, `${b} median`, 'Change', 'Change %', 'Ranges overlap'], rows),
    '',
    verdict,
  ].join('\n');
}

const METHOD = `## Method

- Each run is one \`workflow_dispatch\` of the unmodified workflow on the branch of its label; the shape table says what each label changes.
- A pair is one run of each label, dispatched within minutes of each other. The Created column shows the offsets and the Order in pair column which label went first. A run that overlapped another meets the same runner pool; a run that did not meets whatever the pool held then.
- The API does not expose the size of a hosted runner, so a runner is identified by its label, image and region.
- Timestamps come from the Actions API (jobs and steps, one second resolution) and from the Playwright blob reports (milliseconds). A figure that mixes the two is a difference of durations, never of clocks.
- Completion is the creation time of the run to the completion of its last executed job. Queue delay of a job is its start minus its creation. The queue delay on the critical path adds the queue of every job before the shards, of the shard job that finished last, and of every job after the shards. Execution is completion minus that queue delay, so it contains the hand-over between jobs.
- A run without a complete set of shard timings, because it was cancelled or a shard never reached the test step or lost its blob report, is counted in the pass rate and left out of the timing statistics. The runs that failed their tests keep their timings, because the failure is part of the measured shape.
- The test span of a shard is the first test start to the last test end in its blob report. Time in tests is the sum of every attempt duration, retries included. The prepare time is the test step minus the Playwright run, and the server time is the Playwright run minus the test span.
- Each stage before or after the shards is one job or a chain of jobs, never jobs in parallel; the analysis refuses a record that breaks this, and one worker per shard, because time in tests would not be wall time otherwise.
- The atomic groups are the serial suites listed above and every other test alone, because \`fullyParallel\` is on. Playwright never splits a group across shards. The lower bound is the larger of the ideal share (total time in tests over the shard count) and the largest group. The longest-first packing is a plan that achieves a makespan close to it. Both use the time each test actually took in that run.
- The completion of a run splits into the queue delay, the fixed cost and the test span of the shard that finished last. The test span splits into the ideal share, the excess of the largest group over it, the assignment gap (that shard's time in tests above the lower bound, signed) and the overhead between tests. The parts add up to the completion in every run, but the medians of the parts do not add up to the median completion. The dominant delay is the largest of the fixed cost, the excess and the assignment gap, by median over the runs with timings.
- Spread is max minus min over the median. Two label ranges that overlap are within run-to-run noise.
`;

function render(records) {
  if (records.length === 0) throw new Error('no raw records to render');
  assertConsistent(records);
  const analyzed = records.map(analyzeRun);
  const labels = uniq(records.map((r) => r.label));
  const summaries = labels.map((label) => analyzeLabel(label, runsOf(analyzed, label)));
  if (summaries.some((s) => s.timed === 0)) {
    throw new Error('a label has no run with timings');
  }
  const suite = renderSuite(records);
  const parts = [
    '# couture-cast baseline',
    '',
    'The before measurement for [couture-cast](https://github.com/muratkeremozcan/couture-cast): how long its Playwright workflow takes today, where the time goes, and how much a perfect balance of the shards could save. This document is generated by `npm run measurements:report` from the raw records in [`raw/`](raw/), which `npm run measurements:collect` writes from the GitHub Actions API. Nothing in it is typed by hand.',
    '',
    '## Shape under test',
    '',
    renderShape(records, labels),
    '',
    `The suite has ${suite.count} tests in ${suite.files} spec files. ${suite.serial} of its suites are serial, so Playwright keeps each whole on one shard:`,
    '',
    suite.table,
    '',
    '## Runs',
    '',
    `${records.length} runs. Times are seconds. The critical shard is the shard job that finished last.`,
    '',
    renderRuns(analyzed, labels),
    '',
    '### Pass rate',
    '',
    renderPassRates(summaries, analyzed),
    '',
    '## Medians and spread',
    '',
    renderSummary(summaries),
    '',
    '## Where the time goes',
    '',
    renderDecomposition(analyzed, summaries),
    '',
    '### Dominant delay',
    '',
    renderVerdict(summaries, analyzed),
    '',
    '### Per shard phases',
    '',
    renderShardPhases(analyzed, labels),
    '',
    '### Steps',
    '',
    'Median duration of every step that takes a second or more in either label, over all jobs of that name.',
    '',
    renderSteps(analyzed, labels),
    '',
    '## Balance and headroom',
    '',
    renderBalance(summaries),
    '',
    'Lower bound of the time in tests of the slowest shard at other shard counts, from the same atomic groups:',
    '',
    renderBounds(analyzed, labels),
    '',
    '## Upgrade control',
    '',
    renderUpgrade(analyzed, summaries, labels, records),
    '',
    METHOD,
  ];
  return `${parts.join('\n')}\n`;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined)
      throw new Error(`bad argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.raw || !args.out) throw new Error('--raw and --out are required');
  fs.writeFileSync(args.out, render(loadRecords(args.raw)));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadRecords, render };
