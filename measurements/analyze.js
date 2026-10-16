'use strict';

/**
 * Turns raw run records (see collect.js) into the figures of `docs/measurements/baseline.md`. Every
 * function is pure: a figure is computed from the records and from nothing else.
 */

const { median, rangesOverlap, summarize } = require('./stats');

/** Shard counts the lower bound is reported for. */
const BOUND_SHARDS = [2, 3, 4, 6, 8];

const ms = (iso) => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new Error(`not a timestamp: ${iso}`);
  return value;
};

/** Throws when a record is not one this analysis can trust; a bad record never reaches a median. */
function validateRecord(record) {
  const where = `run ${record.run && record.run.id}`;
  if (record.schema !== 1) throw new Error(`${where}: unknown schema ${record.schema}`);
  if (record.run.status !== 'completed') throw new Error(`${where}: run is not completed`);
  if (record.run.attempt !== 1) {
    throw new Error(`${where}: attempt ${record.run.attempt}, only first attempts are measured`);
  }
  if (!Array.isArray(record.jobs) || !Array.isArray(record.shards) || record.shards.length === 0) {
    throw new Error(`${where}: jobs or shards are missing`);
  }
  if (!Number.isInteger(record.pair) || record.pair < 1)
    throw new Error(`${where}: no pair number`);
  const ids = new Set(record.jobs.map((job) => job.id));
  const seen = new Set();
  record.shards.forEach((shard, position) => {
    if (shard.index !== position + 1) throw new Error(`${where}: shard indices are not 1 to N`);
  });
  for (const shard of record.shards) {
    if (!ids.has(shard.jobId)) throw new Error(`${where}: shard ${shard.index} has no job`);
    if (shard.total !== record.shards.length) {
      throw new Error(`${where}: shard ${shard.index} reports ${shard.total} shards`);
    }
    if (!shard.blob && !shard.blobMissing) {
      throw new Error(`${where}: shard ${shard.index} has neither a blob nor a reason`);
    }
    if (!shard.blob) continue;
    if (!shard.blob.shard)
      throw new Error(`${where}: the blob of shard ${shard.index} has no shard`);
    if (shard.blob.workers !== 1) {
      throw new Error(
        `${where}: shard ${shard.index} runs ${shard.blob.workers} workers, the analysis assumes one`
      );
    }
    if (shard.blob.shard.current !== shard.index || shard.blob.shard.total !== shard.total) {
      throw new Error(
        `${where}: the blob of shard ${shard.index} is shard ${shard.blob.shard.current}`
      );
    }
    for (const test of shard.blob.tests) {
      if (seen.has(test.id)) throw new Error(`${where}: test ${test.id} ran in two shards`);
      seen.add(test.id);
    }
  }
}

const durationOf = (job) => ms(job.completedAt) - ms(job.startedAt);
const queueOf = (job) => {
  const queue = ms(job.startedAt) - ms(job.createdAt);
  if (queue < 0) throw new Error(`job ${job.name} started before it was created`);
  return queue;
};

/** The outcome of one test from its attempts: passed, flaky, failed or skipped. */
function outcomeOf(test) {
  const last = test.attempts[test.attempts.length - 1];
  if (!last) return 'failed';
  if (last.status === 'skipped') return 'skipped';
  if (last.status !== test.expectedStatus) return 'failed';
  return test.attempts.length > 1 ? 'flaky' : 'passed';
}

/**
 * The atomic unit of each test: its serial suite, or with `fullyParallel` the test itself, or
 * otherwise its file. Playwright shards by these units and never splits one.
 */
function unitKey(test, record) {
  for (const serial of record.serialSuites) {
    if (test.file === serial.file && test.titlePath.includes(serial.suite)) {
      return `${test.project}::${serial.file}::${serial.suite}`;
    }
  }
  return record.facts.fullyParallel ? test.id : `${test.project}::${test.file}`;
}

function unitsOf(record) {
  const units = new Map();
  const shardOfUnit = new Map();
  for (const shard of record.shards) {
    for (const test of shard.blob.tests) {
      const key = unitKey(test, record);
      const weight = test.attempts.reduce((sum, attempt) => sum + attempt.duration, 0);
      units.set(key, (units.get(key) || 0) + weight);
      if (shardOfUnit.has(key) && shardOfUnit.get(key) !== shard.index) {
        throw new Error(`run ${record.run.id}: atomic unit ${key} was split across shards`);
      }
      shardOfUnit.set(key, shard.index);
    }
  }
  for (const serial of record.serialSuites) {
    const matched = [...units.keys()].some((key) =>
      key.endsWith(`::${serial.file}::${serial.suite}`)
    );
    if (!matched) {
      throw new Error(`run ${record.run.id}: serial suite "${serial.suite}" matches no test`);
    }
  }
  return units;
}

/** Longest-processing-time-first packing: an achievable plan, never below the lower bound. */
function packLongestFirst(weights, bins) {
  const loads = new Array(bins).fill(0);
  for (const weight of [...weights].sort((a, b) => b - a)) {
    loads[loads.indexOf(Math.min(...loads))] += weight;
  }
  return Math.max(...loads);
}

/** Balance of the tests across shards, and the bound no assignment of the same units can beat. */
function balanceOf(record, shardFigures) {
  const units = unitsOf(record);
  const weights = [...units.values()];
  const bins = record.shards.length;
  const total = weights.reduce((sum, w) => sum + w, 0);
  const share = total / bins;
  const largest = Math.max(...weights);
  const busy = shardFigures.map((shard) => shard.busy);
  return {
    total,
    share,
    largestUnit: largest,
    lowerBound: Math.max(share, largest),
    packed: packLongestFirst(weights, bins),
    bounds: Object.fromEntries(BOUND_SHARDS.map((n) => [n, Math.max(total / n, largest)])),
    slowestBusy: Math.max(...busy),
    busiestShare: Math.max(...busy) / share,
    units: weights.length,
  };
}

function shardFigures(record, shard, job) {
  const stepName = record.testStep;
  const testStep = job.steps.find((step) => step.name === stepName);
  if (!testStep || !['success', 'failure'].includes(testStep.conclusion)) {
    const stopped = job.steps.find(
      (step) => step.conclusion && !['success', 'skipped'].includes(step.conclusion)
    );
    const where = stopped
      ? `stopped at "${stopped.name}" (${stopped.conclusion})${job.failureNote ? `: ${job.failureNote}` : ''}`
      : `never reached "${stepName}"`;
    return { missing: `shard ${shard.index} ${where}` };
  }
  if (!shard.blob) return { missing: `shard ${shard.index}: ${shard.blobMissing}` };
  const attempts = shard.blob.tests.flatMap((test) => test.attempts);
  if (attempts.length === 0) return { missing: `shard ${shard.index} ran no test` };
  const first = Math.min(...attempts.map((a) => a.startTime));
  const last = Math.max(...attempts.map((a) => a.startTime + a.duration));
  const stepMs = ms(testStep.completedAt) - ms(testStep.startedAt);
  const runMs = shard.blob.run.duration;
  const outcomes = shard.blob.tests.map(outcomeOf);
  const count = (kind) => outcomes.filter((o) => o === kind).length;
  return {
    index: shard.index,
    jobMs: durationOf(job),
    queueMs: queueOf(job),
    setupMs: ms(testStep.startedAt) - ms(job.startedAt),
    testStepMs: stepMs,
    prepareMs: stepMs - runMs,
    serverMs: runMs - (last - first),
    spanMs: last - first,
    busy: attempts.reduce((sum, a) => sum + a.duration, 0),
    afterMs: ms(job.completedAt) - ms(testStep.completedAt),
    tests: shard.blob.tests.length,
    attempts: attempts.length,
    retries: shard.blob.tests.reduce((sum, t) => sum + Math.max(0, t.attempts.length - 1), 0),
    passed: count('passed'),
    flaky: count('flaky'),
    failed: count('failed'),
    skipped: count('skipped'),
    completedAt: ms(job.completedAt),
  };
}

/** Figures of one run. `excluded` names why the run has no timings; it is still counted. */
function analyzeRun(record) {
  validateRecord(record);
  const executed = record.jobs.filter(
    (job) => job.conclusion !== 'skipped' && job.startedAt && job.completedAt
  );
  const jobOf = (shard) => record.jobs.find((job) => job.id === shard.jobId);
  const base = {
    label: record.label,
    id: record.run.id,
    pair: record.pair,
    url: record.run.url,
    sha: record.run.sha,
    branch: record.run.branch,
    conclusion: record.run.conclusion,
    createdAt: ms(record.run.createdAt),
  };
  const shards = [];
  for (const shard of record.shards) {
    const figures = shardFigures(record, shard, jobOf(shard));
    if (figures.missing) return { ...base, excluded: figures.missing };
    shards.push(figures);
  }
  const shardJobIds = new Set(record.shards.map((shard) => shard.jobId));
  const others = executed.filter((job) => !shardJobIds.has(job.id));
  const firstShardStart = Math.min(...record.shards.map((s) => ms(jobOf(s).startedAt)));
  // a job that was done when the first shard started ran before the shards; any other ran after
  const before = others.filter((job) => ms(job.completedAt) <= firstShardStart);
  const after = others.filter((job) => ms(job.completedAt) > firstShardStart);
  assertSequential(before, record, 'before the shards');
  assertSequential(after, record, 'after the shards');
  const critical = shards.reduce((a, b) => (b.completedAt > a.completedAt ? b : a));
  const completion = Math.max(...executed.map((job) => ms(job.completedAt))) - base.createdAt;
  const queueCritical =
    before.reduce((sum, job) => sum + queueOf(job), 0) +
    critical.queueMs +
    after.reduce((sum, job) => sum + queueOf(job), 0);
  const balance = balanceOf(record, shards);
  const execution = completion - queueCritical;
  const fixed = execution - critical.spanMs;
  const inTestOverhead = critical.spanMs - critical.busy;
  const stepTimes = new Map();
  for (const job of executed) {
    for (const step of job.steps) {
      if (step.conclusion === 'skipped' || !step.startedAt || !step.completedAt) continue;
      const key = `${job.name.replace(/ \(\d+, \d+\)$/, '')}\u0000${step.name}`;
      if (!stepTimes.has(key)) stepTimes.set(key, []);
      stepTimes.get(key).push(ms(step.completedAt) - ms(step.startedAt));
    }
  }
  return {
    ...base,
    shards,
    completion,
    queueCritical,
    execution,
    aggregateRunnerMs: executed.reduce((sum, job) => sum + durationOf(job), 0),
    slowestJobMs: Math.max(...shards.map((s) => s.jobMs)),
    fastestJobMs: Math.min(...shards.map((s) => s.jobMs)),
    criticalShard: critical.index,
    beforeMs: before.reduce((sum, job) => sum + durationOf(job), 0),
    afterJobsMs: after.reduce((sum, job) => sum + durationOf(job), 0),
    balance,
    // completion = queue + fixed + the critical shard's test span, exactly
    decomposition: {
      queue: queueCritical,
      fixed,
      share: balance.share,
      atomicExcess: balance.lowerBound - balance.share,
      assignmentGap: critical.busy - balance.lowerBound,
      inTestOverhead,
    },
    stepTimes: Object.fromEntries(stepTimes),
    tests: shards.reduce((sum, s) => sum + s.tests, 0),
    attempts: shards.reduce((sum, s) => sum + s.attempts, 0),
    retries: shards.reduce((sum, s) => sum + s.retries, 0),
    flaky: shards.reduce((sum, s) => sum + s.flaky, 0),
    failed: shards.reduce((sum, s) => sum + s.failed, 0),
  };
}

/** The queue of a stage is summed along the critical path, so stages must not run in parallel. */
function assertSequential(jobs, record, where) {
  const ordered = [...jobs].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  ordered.slice(1).forEach((job, i) => {
    if (ms(job.startedAt) < ms(ordered[i].completedAt)) {
      throw new Error(
        `run ${record.run.id}: jobs ${where} run in parallel, which is not supported`
      );
    }
  });
}

/** Which of the three delays is largest: fixed cost, an oversized atomic unit or the assignment. */
function dominantDelay(decomposition) {
  const candidates = [
    ["time outside the critical shard's test span", decomposition.fixed],
    ['one oversized atomic group', decomposition.atomicExcess],
    ['uneven assignment', decomposition.assignmentGap],
  ];
  return candidates.reduce((best, next) => (next[1] > best[1] ? next : best))[0];
}

const DECOMPOSITION_KEYS = [
  'queue',
  'fixed',
  'share',
  'atomicExcess',
  'assignmentGap',
  'inTestOverhead',
];

/** Everything computed for one label across its runs. */
function analyzeLabel(label, runs) {
  const timed = runs.filter((run) => !run.excluded);
  const pick = (fn) => (timed.length === 0 ? null : summarize(timed.map(fn)));
  const decomposition = {};
  if (timed.length > 0) {
    for (const key of DECOMPOSITION_KEYS) {
      decomposition[key] = median(timed.map((run) => run.decomposition[key]));
    }
  }
  return {
    label,
    runs: runs.length,
    succeeded: runs.filter((run) => run.conclusion === 'success').length,
    timed: timed.length,
    excluded: runs.filter((run) => run.excluded).map((run) => ({ id: run.id, why: run.excluded })),
    completion: pick((run) => run.completion),
    queueCritical: pick((run) => run.queueCritical),
    execution: pick((run) => run.execution),
    slowestJob: pick((run) => run.slowestJobMs),
    fastestJob: pick((run) => run.fastestJobMs),
    fixed: pick((run) => run.decomposition.fixed),
    aggregateRunner: pick((run) => run.aggregateRunnerMs),
    jobImbalance: pick((run) => run.slowestJobMs / run.fastestJobMs),
    busiestShare: pick((run) => run.balance.busiestShare),
    slowestBusy: pick((run) => run.balance.slowestBusy),
    lowerBound: pick((run) => run.balance.lowerBound),
    packed: pick((run) => run.balance.packed),
    largestUnit: pick((run) => run.balance.largestUnit),
    headroom: pick((run) => Math.max(0, run.balance.slowestBusy - run.balance.lowerBound)),
    retries: pick((run) => run.retries),
    failed: pick((run) => run.failed),
    decomposition,
    dominant: timed.length === 0 ? null : dominantDelay(decomposition),
  };
}

/** The upgrade control: label B against label A, medians and whether the ranges overlap. */
function compareLabels(a, b, metric) {
  const values = (runs) => runs.filter((run) => !run.excluded).map(metric);
  const left = values(a);
  const right = values(b);
  return {
    medianA: median(left),
    medianB: median(right),
    delta: median(right) - median(left),
    ratio: median(right) / median(left) - 1,
    overlap: rangesOverlap(left, right),
  };
}

module.exports = {
  BOUND_SHARDS,
  analyzeLabel,
  analyzeRun,
  balanceOf,
  compareLabels,
  dominantDelay,
  outcomeOf,
  packLongestFirst,
  unitKey,
  validateRecord,
};
