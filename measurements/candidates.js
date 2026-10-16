'use strict';

/**
 * Renders `docs/measurements/candidates.md` from the raw records of the candidate runs, the S5
 * baseline records and the S4b simulation evidence. The document is generated whole: its prose
 * carries no figure that is not computed here from those inputs. Usage:
 *
 *   node measurements/candidates.js --raw docs/measurements/raw/candidates \
 *     --baseline docs/measurements/raw --evidence docs/research/shard-balancer-evidence.json \
 *     --out docs/measurements/candidates.md
 */

const fs = require('node:fs');
const { percent, signedPercent, table } = require('../qualification/lib/tables');
const { analyzeRun } = require('./analyze');
const { MAX_GAP_MS, pairStates } = require('./pairs');
const { loadRecords } = require('./render');
const { fisherGreater, median, medianInterval } = require('./stats');

/** The baseline label measured with the same Playwright as the candidates. */
const BASELINE_LABEL = 'baseline-b';
/** The S5 step that lost runs to the image registry limit, which step 0 changed. */
const SETUP_STEP = 'Start local Supabase services';
/** The provisional gate of the spec; reported against, never used to drop a number. */
const GATE = 0.1;
/** How many of the longest setup steps the next-saving list names. */
const NEXT_STEPS = 3;
/** Coverage asked of the interval for the median change within a pair. */
const LEVEL = 0.9;
/** One-sided significance for "the arm has more runs with a bad test than the control". */
const ALPHA = 0.05;
const CACHE_MISS = /^Cache not found for input keys:/;

const sec = (value) => `${(value / 1000).toFixed(1)} s`;
const secSigned = (value) => `${value >= 0 ? '+' : '-'}${(Math.abs(value) / 1000).toFixed(1)} s`;
const uniq = (values) => [...new Set(values)].sort();
const joined = (values) => uniq(values.filter((v) => v !== null && v !== undefined)).join(', ');
const timeOf = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const code = (names) => names.map((t) => `\`${t}\``).join('<br>');
const baseName = (name) => name.replace(/ \(repeat \d+\)$/, '');

/** Figures the S5 analysis does not keep but the candidates need, from the analyzed run. */
function extend(run) {
  if (run.excluded) return run;
  const critical = run.shards[run.criticalShard - 1];
  const slowest = run.shards.reduce((a, b) => (b.jobMs > a.jobMs ? b : a));
  return {
    ...run,
    machineMs: run.shards.reduce((sum, s) => sum + s.jobMs, 0),
    beforeTestsMs: critical.setupMs + critical.prepareMs,
    slowestAfterSetupMs: slowest.jobMs - slowest.setupMs,
    // the S4b overhead: everything in a shard job outside its Playwright run
    overheadMs: median(run.shards.map((s) => s.jobMs - s.runMs)),
  };
}

/** Records of one document share their target and their base; a mixed set would mislead. */
function assertCandidates(records) {
  const first = records[0];
  const target = (r) =>
    JSON.stringify([r.repo, r.workflow, r.testStep, r.facts, r.serialSuites, r.base.sha]);
  for (const record of records) {
    if (record.schema !== 2) throw new Error(`run ${record.run.id} is not an arm record`);
    if (target(record) !== target(first)) {
      throw new Error(`run ${record.run.id} measures a different target than run ${first.run.id}`);
    }
    if (record.arm.phase === 'measured' && !record.comparison) {
      throw new Error(`run ${record.run.id} is measured but paired with nothing`);
    }
  }
  const ids = records.map((r) => r.run.id);
  if (new Set(ids).size !== ids.length) throw new Error('a run appears in two records');
}

/** The control, the arms and the other phases, read back from the records. */
function configOf(records) {
  const measured = records.filter((r) => r.arm.phase === 'measured');
  const controls = uniq(measured.filter((r) => r.comparison !== r.label).map((r) => r.label));
  if (controls.length !== 1)
    throw new Error(`expected one control label, found ${controls.length}`);
  const control = controls[0];
  const ofPhase = (phase) => uniq(records.filter((r) => r.arm.phase === phase).map((r) => r.label));
  return {
    control,
    arms: uniq(measured.filter((r) => r.label !== control).map((r) => r.label)),
    warmups: ofPhase('warm-up'),
    tolerance: ofPhase('tolerance'),
  };
}

/** The pairs of every arm by status, from the shared pairing rules. */
function pairsByArm(runs, cfg) {
  return Object.fromEntries(
    cfg.arms.map((arm) => {
      const states = pairStates(runs, cfg.control, arm);
      return [arm, { states, matched: states.filter((s) => s.status === 'matched') }];
    })
  );
}

/** A Flakiness duration as the reporter prints it: `850ms`, `61.2s`, `1m 16s` or `1h 02m`. */
function parseDuration(text) {
  let match = /^(\d+)ms$/.exec(text);
  if (match) return Number(match[1]);
  match = /^(\d+(?:\.\d+)?)s$/.exec(text);
  if (match) return Math.round(Number(match[1]) * 1000);
  match = /^(\d+)m (\d+)s$/.exec(text);
  if (match) return (Number(match[1]) * 60 + Number(match[2])) * 1000;
  match = /^(\d+)h (\d+)m$/.exec(text);
  if (match) return (Number(match[1]) * 60 + Number(match[2])) * 60000;
  throw new Error(`not a Flakiness duration: ${text}`);
}

/** The plan lines of the Flakiness reporter, read back into numbers. */
function parseEngine(lines) {
  if (!lines) return null;
  const find = (pattern) => {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match) return match;
    }
    return null;
  };
  const hints = find(/duration hints:\s+(\d+)\/(\d+) tests/);
  const balance = find(/balance:\s+(\d+)%/);
  const loads = find(/shard loads:\s+(.+)$/);
  const finishedLine = lines.find((line) => /Shard \d+\/\d+ finished:/.test(line));
  let predictedMs = null;
  let actualMs = null;
  if (finishedLine) {
    const predicted = /finished: predicted (.+?) of work, actual (.+?) \(/.exec(finishedLine);
    const unpredicted = /finished: (.+?) of work \(no prediction to compare against\)/.exec(
      finishedLine
    );
    if (predicted) {
      predictedMs = parseDuration(predicted[1]);
      actualMs = parseDuration(predicted[2]);
    } else if (unpredicted) {
      actualMs = parseDuration(unpredicted[1]);
    } else {
      throw new Error(`unreadable Flakiness line: ${finishedLine}`);
    }
  }
  return {
    hinted: hints ? Number(hints[1]) : null,
    planned: hints ? Number(hints[2]) : null,
    balance: balance ? Number(balance[1]) / 100 : null,
    loads: loads ? loads[1].trim() : null,
    predictedMs,
    actualMs,
  };
}

/** Plans of every shard of an engine run, and whether all shards planned alike and in full. */
function engineCheck(record) {
  const plans = record.shards.map((shard) =>
    parseEngine(record.jobs.find((j) => j.id === shard.jobId).engineLines)
  );
  const everyShard = plans.every((p) => p && p.planned !== null && p.loads !== null);
  const same =
    everyShard && plans.every((p) => p.loads === plans[0].loads && p.planned === plans[0].planned);
  return {
    plans,
    balanced: everyShard && same,
    fullHints: everyShard && plans.every((p) => p.hinted === p.planned),
  };
}

const cacheMisses = (record) =>
  record.collectError
    ? null
    : record.jobs.flatMap((job) => job.cacheLines || []).filter((line) => CACHE_MISS.test(line))
        .length;

const overlapCount = (record) =>
  record.dispatch && Array.isArray(record.dispatch.overlapping)
    ? record.dispatch.overlapping.length
    : null;

function renderArms(records, cfg) {
  const labels = [cfg.control, ...cfg.arms, ...cfg.warmups, ...cfg.tolerance];
  const rows = labels.map((label) => {
    const of = records.filter((r) => r.label === label);
    const arm = of[0].arm;
    return [
      `\`${label}\``,
      arm.phase,
      joined(of.map((r) => r.labelNote)),
      joined(of.map((r) => r.run.branch)),
      joined(of.map((r) => r.run.sha.slice(0, 12))),
      joined(of.map((r) => String(r.base.aheadBy))),
      String(arm.shards),
      String(arm.workers),
      arm.engine,
      `\`${arm.command}\``,
    ];
  });
  return table(
    [
      'Label',
      'Phase',
      'What it changes',
      'Branch',
      'Commit',
      'Commits past the base',
      'Shards',
      'Workers per shard',
      'Balancing',
      'Command',
    ],
    rows
  );
}

function renderShape(records, cfg) {
  const full = records.filter((r) => !r.collectError);
  const first = records[0];
  const blobs = full.flatMap((r) => r.shards.filter((s) => s.blob).map((s) => s.blob));
  const packages = uniq(full.flatMap((r) => Object.keys(r.resolved)));
  const rows = [
    [
      'Repository',
      `[${first.repo.owner}/${first.repo.name}](https://github.com/${first.repo.owner}/${first.repo.name})`,
    ],
    [
      'Workflow',
      `\`${first.workflow}\`, started with \`${joined(records.map((r) => r.run.event))}\``,
    ],
    ['Base commit of every arm', `\`${first.base.sha.slice(0, 12)}\``],
    [
      'Minimum commit (no run predates it)',
      `\`${joined(records.map((r) => r.base.minimum.slice(0, 12)))}\``,
    ],
    ['Concurrency', first.facts.concurrency],
    ['`fullyParallel`', String(first.facts.fullyParallel)],
    ['Retries', joined(blobs.flatMap((b) => b.projects.map((p) => String(p.retries))))],
    ['Projects', joined(blobs.flatMap((b) => b.projects.map((p) => p.name)))],
    [
      'Runner',
      `${joined(full.flatMap((r) => r.jobs.map((j) => j.labels.join('+'))).filter(Boolean))}, runner group ${joined(full.flatMap((r) => r.jobs.map((j) => j.runnerGroup)))}, ${joined(full.flatMap((r) => r.jobs.map((j) => j.runner && j.runner.image && `${j.runner.image} ${j.runner.imageVersion}`)))}`,
    ],
    ['Runner regions', joined(full.flatMap((r) => r.jobs.map((j) => j.runner && j.runner.region)))],
    ['Playwright in the blob reports', joined(blobs.map((b) => b.playwrightVersion))],
    ['Node in the blob reports', joined(blobs.map((b) => b.node))],
  ];
  for (const name of packages) {
    for (const label of [cfg.control, ...cfg.arms, ...cfg.warmups, ...cfg.tolerance]) {
      const versions = full.filter((r) => r.label === label).map((r) => r.resolved[name]);
      rows.push([
        `\`${name}\` in the lockfile of \`${label}\``,
        joined(versions) || 'not installed',
      ]);
    }
  }
  return table(['Property', 'Value'], rows);
}

/** The run that took the slot of a run without timings, if one did. */
function replacementOf(run, runs) {
  const later = runs.find(
    (other) =>
      other.label === run.label &&
      other.pair === run.pair &&
      other.comparison === run.comparison &&
      !other.excluded &&
      other.createdAt > run.createdAt
  );
  if (run.cause === 'in-tests') return '; counts against its label and is never replaced';
  return later ? `; replaced by ${later.id}` : '';
}

function orderInPair(run, states) {
  if (!run.comparison) return 'n/a';
  const state = states.find((s) => s.pair === run.pair);
  if (!state || state.status === 'open' || state.status === 'broken') return 'n/a';
  const other = state.controlRun === run ? state.armRun : state.controlRun;
  if (state.controlRun !== run && state.armRun !== run) return 'n/a';
  return run.createdAt < other.createdAt ? 'first' : 'second';
}

function renderRuns(runs, phase, byArm, recordsById) {
  const states = (run) =>
    run.comparison && byArm[run.comparison] ? byArm[run.comparison].states : [];
  const rows = runs
    .filter((r) => r.phase === phase)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((run) => {
      const record = recordsById.get(run.id);
      const misses = cacheMisses(record);
      const overlap = overlapCount(record);
      const head = [
        `\`${run.label}\``,
        run.comparison ? `\`${run.comparison}\`` : 'n/a',
        String(run.pair),
        `[${run.id}](${run.url})`,
        timeOf(run.createdAt),
        orderInPair(run, states(run)),
        run.conclusion,
        overlap === null ? 'n/a' : String(overlap),
        misses === null ? 'n/a' : String(misses),
      ];
      if (run.excluded) {
        return [
          ...head,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          `${run.excluded}${replacementOf(run, runs)}`,
        ];
      }
      return [
        ...head,
        sec(run.queueCritical),
        sec(run.execution),
        sec(run.completion),
        run.shards.map((s) => (s.jobMs / 1000).toFixed(0)).join(' / '),
        sec(run.machineMs),
        sec(run.beforeTestsMs),
        `${run.tests} / ${run.skipped}`,
        `${run.retries} / ${run.flaky} / ${run.failed}`,
        '',
      ];
    });
  if (rows.length === 0) return `No ${phase} runs.`;
  return table(
    [
      'Label',
      'Paired for',
      'Pair',
      'Run',
      'Created (UTC)',
      'Order in pair',
      'Result',
      'Other runs of the repository during it',
      'Cache misses',
      'Queue on critical path',
      'Execution',
      'Completion',
      'Shard jobs (s)',
      'Machine time (shard jobs)',
      'Critical shard before tests',
      'Tests / skipped',
      'Retries / flaky / failed',
      'Excluded from timings',
    ],
    rows
  );
}

function renderEngine(records) {
  const rows = [];
  const sorted = [...records].sort(
    (a, b) => Date.parse(a.run.createdAt) - Date.parse(b.run.createdAt)
  );
  for (const record of sorted) {
    if (record.arm.engine === 'native' || record.collectError) continue;
    const check = engineCheck(record);
    record.shards.forEach((shard, i) => {
      const plan = check.plans[i];
      rows.push([
        `\`${record.label}\``,
        `[${record.run.id}](${record.run.url})`,
        String(shard.index),
        plan && plan.planned !== null ? `${plan.hinted} / ${plan.planned}` : 'no plan line',
        plan && plan.loads !== null ? plan.loads : 'n/a',
        plan && plan.balance !== null ? percent(plan.balance) : 'n/a',
        plan && plan.predictedMs !== null ? sec(plan.predictedMs) : 'n/a',
        plan && plan.actualMs !== null ? sec(plan.actualMs) : 'n/a',
        check.balanced ? 'yes' : 'no',
      ]);
    });
  }
  if (rows.length === 0) return 'No arm balances with an engine.';
  return table(
    [
      'Label',
      'Run',
      'Shard',
      'Tests with a duration hint',
      'Planned shard loads',
      'Planned balance',
      'Predicted work',
      'Actual work',
      'Every shard printed the same plan',
    ],
    rows
  );
}

/** Medians of both sides of an arm's matched pairs, and the change from the control to the arm. */
function compare(pairs, metric) {
  const left = pairs.map((p) => metric(p.controlRun));
  const right = pairs.map((p) => metric(p.armRun));
  const deltas = pairs.map((p) => metric(p.armRun) - metric(p.controlRun));
  const interval = medianInterval(deltas, LEVEL);
  return {
    control: median(left),
    arm: median(right),
    delta: median(right) - median(left),
    ratio: median(right) / median(left) - 1,
    pairedDelta: median(deltas),
    interval,
    armFaster: deltas.filter((d) => d < 0).length,
    verdict:
      interval.high < 0 ? 'faster' : interval.low > 0 ? 'slower' : 'no detectable difference',
  };
}

function runsWithoutTimings(runs, label, arm) {
  const of = runs.filter((r) => r.label === label && r.comparison === arm);
  return `${of.filter((r) => r.excluded).length} / ${of.length}`;
}

function renderCompletion(cfg, byArm, runs) {
  const rows = cfg.arms.map((arm) => {
    const { matched } = byArm[arm];
    const lost = `${runsWithoutTimings(runs, arm, arm)} and ${runsWithoutTimings(runs, cfg.control, arm)}`;
    if (matched.length === 0) {
      return [`\`${arm}\``, '0', lost, '', '', '', '', '', '', '', '', 'no matched pair'];
    }
    const c = compare(matched, (r) => r.completion);
    const controlFirst = matched.filter((p) => p.controlRun.createdAt < p.armRun.createdAt).length;
    return [
      `\`${arm}\``,
      String(matched.length),
      lost,
      sec(c.control),
      sec(c.arm),
      `${secSigned(c.delta)} (${signedPercent(c.ratio)})`,
      secSigned(c.pairedDelta),
      `${secSigned(c.interval.low)} to ${secSigned(c.interval.high)} (${percent(c.interval.coverage)})`,
      `${c.armFaster} of ${matched.length}`,
      `${controlFirst} of ${matched.length}`,
      sec(Math.max(...matched.map((p) => p.gapMs))),
      c.verdict,
    ];
  });
  return table(
    [
      'Arm',
      'Matched pairs',
      'Runs without timings, arm and control',
      'Control median',
      'Arm median',
      'Change of the medians',
      'Median change within a pair',
      'Interval for that median (coverage)',
      'Arm faster',
      'Control ran first',
      'Longest gap inside a pair',
      'Verdict',
    ],
    rows
  );
}

function renderPairs(cfg, byArm, recordsById) {
  const rows = [];
  for (const arm of cfg.arms) {
    for (const state of byArm[arm].states) {
      if (state.status !== 'matched' && state.status !== 'stale') {
        rows.push([`\`${arm}\``, String(state.pair), state.status, '', '', '', '', '', '', '']);
        continue;
      }
      const c = state.controlRun;
      const a = state.armRun;
      rows.push([
        `\`${arm}\``,
        String(state.pair),
        state.status,
        `[${c.id}](${c.url})`,
        `[${a.id}](${a.url})`,
        sec(state.gapMs),
        sec(c.completion),
        sec(a.completion),
        secSigned(a.completion - c.completion),
        `${cacheMisses(recordsById.get(c.id))} / ${cacheMisses(recordsById.get(a.id))}`,
      ]);
    }
  }
  return table(
    [
      'Arm',
      'Pair',
      'Status',
      'Control run',
      'Arm run',
      'Gap',
      'Control completion',
      'Arm completion',
      'Change',
      'Cache misses, control / arm',
    ],
    rows
  );
}

function renderCost(cfg, byArm) {
  const metrics = [
    ['Machine time (sum of shard jobs)', (r) => r.machineMs],
    ['Runner time of all jobs', (r) => r.aggregateRunnerMs],
    ['Slowest shard job', (r) => r.slowestJobMs],
    ['Slowest shard job after its setup steps', (r) => r.slowestAfterSetupMs],
    ['Critical shard before tests', (r) => r.beforeTestsMs],
    ['Slowest shard, time in tests per worker', (r) => r.balance.slowestBusy],
    ['Queue delay on the critical path', (r) => r.queueCritical],
  ];
  const rows = [];
  for (const arm of cfg.arms) {
    const { matched } = byArm[arm];
    if (matched.length === 0) continue;
    for (const [name, fn] of metrics) {
      const c = compare(matched, fn);
      rows.push([
        `\`${arm}\``,
        name,
        sec(c.control),
        sec(c.arm),
        secSigned(c.delta),
        signedPercent(c.ratio),
        secSigned(c.pairedDelta),
      ]);
    }
  }
  return table(
    [
      'Arm',
      'Measure',
      'Control median',
      'Arm median',
      'Change',
      'Change %',
      'Median change within a pair',
    ],
    rows
  );
}

/** Steps of an arm's shard jobs that the control's shard jobs do not have, by median. */
function renderArmSteps(cfg, runs) {
  const keysOf = (label) =>
    new Set(
      runs
        .filter((r) => r.label === label && !r.excluded)
        .flatMap((r) => Object.keys(r.stepTimes))
        .filter((key) => key.startsWith('pw-e2e\u0000'))
    );
  const control = keysOf(cfg.control);
  const rows = [];
  for (const arm of cfg.arms) {
    for (const key of [...keysOf(arm)].sort()) {
      if (control.has(key)) continue;
      const values = runs
        .filter((r) => r.label === arm && !r.excluded)
        .flatMap((r) => r.stepTimes[key] || []);
      rows.push([`\`${arm}\``, key.split('\u0000')[1], sec(median(values))]);
    }
  }
  if (rows.length === 0) return 'No arm adds a step to the shard jobs.';
  return table(['Arm', 'Step the control does not run', 'Median per shard job'], rows);
}

/** The test set the control runs: the set most of its runs listed. */
function referenceSet(controlRuns) {
  const counts = new Map();
  for (const run of controlRuns) {
    const key = JSON.stringify(run.listedTests);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best ? JSON.parse(best[0]) : [];
}

/**
 * Correctness of an arm against every control run. A run is bad when a test failed or went
 * flaky, when it lost its timings inside the tests, or could not be collected. The arm regresses
 * when a run listed another set of tests than the control, an engine run did not balance, the same
 * test went bad in two arm runs and in no control run, or the arm has more bad runs than the
 * control by a one-sided Fisher exact test at ALPHA. Any other test that went bad only in the arm
 * makes it inconclusive.
 */
function correctnessOf(label, runs, cfg, recordsById, phase = 'measured') {
  const controlAll = runs.filter((r) => r.label === cfg.control && r.phase === 'measured');
  const armAll = runs.filter((r) => r.label === label && r.phase === phase);
  const timed = (list) => list.filter((r) => !r.excluded);
  const unusable = (list) => list.filter((r) => r.excluded && r.cause !== 'before-tests');
  const badTests = (run) => [...run.failedTests, ...run.flakyTests].map(baseName);
  const bad = (run) => run.excluded || run.failedTests.length + run.flakyTests.length > 0;
  const controlBad = new Set(timed(controlAll).flatMap(badTests));
  const counted = (list) => [...timed(list), ...unusable(list)];
  const armCounted = counted(armAll);
  const controlCounted = counted(controlAll);
  const armBadRuns = armCounted.filter(bad).length;
  const controlBadRuns = controlCounted.filter(bad).length;
  const p = fisherGreater(armBadRuns, armCounted.length, controlBadRuns, controlCounted.length);
  const occurrences = new Map();
  for (const run of timed(armAll)) {
    for (const name of uniq(badTests(run))) {
      if (!controlBad.has(name)) occurrences.set(name, (occurrences.get(name) || 0) + 1);
    }
  }
  const repeated = [...occurrences].filter(([, n]) => n >= 2).map(([name]) => name);
  const once = [...occurrences].filter(([, n]) => n === 1).map(([name]) => name);
  const reference = JSON.stringify(referenceSet(timed(controlAll)));
  const lostTests =
    phase === 'measured' && timed(armAll).some((r) => JSON.stringify(r.listedTests) !== reference);
  const unbalanced = timed(armAll).filter((r) => {
    const record = recordsById.get(r.id);
    return record.arm.engine !== 'native' && !engineCheck(record).balanced;
  }).length;
  const reasons = [
    lostTests ? 'a run listed another set of tests than the control' : null,
    unbalanced > 0 ? `${unbalanced} run(s) did not balance on every shard` : null,
    repeated.length > 0
      ? `${repeated.length} test(s) went bad in two or more arm runs and in no control run`
      : null,
    p < ALPHA ? `more runs with a bad test than the control (p = ${p.toFixed(3)})` : null,
  ].filter(Boolean);
  return {
    label,
    runs: armCounted.length,
    badRuns: armBadRuns,
    controlRuns: controlCounted.length,
    controlBadRuns,
    p,
    retries: timed(armAll).reduce((s, r) => s + r.retries, 0),
    flaky: timed(armAll).reduce((s, r) => s + r.flaky, 0),
    failed: timed(armAll).reduce((s, r) => s + r.failed, 0),
    unusable: unusable(armAll).length,
    repeated,
    once,
    reasons,
    verdict: reasons.length > 0 ? 'regression' : once.length > 0 ? 'inconclusive' : 'no regression',
  };
}

function renderCorrectness(cfg, runs, recordsById) {
  const control = runs.filter(
    (r) => r.label === cfg.control && r.phase === 'measured' && !r.excluded
  );
  const rows = [
    [
      `\`${cfg.control}\``,
      `${control.filter((r) => r.failedTests.length + r.flakyTests.length > 0).length} of ${control.length}`,
      'n/a',
      String(control.reduce((s, r) => s + r.retries, 0)),
      String(control.reduce((s, r) => s + r.flaky, 0)),
      String(control.reduce((s, r) => s + r.failed, 0)),
      'n/a',
      'n/a',
      'reference',
    ],
  ];
  for (const arm of cfg.arms) {
    const c = correctnessOf(arm, runs, cfg, recordsById);
    rows.push([
      `\`${arm}\``,
      `${c.badRuns} of ${c.runs}`,
      c.p.toFixed(3),
      String(c.retries),
      String(c.flaky),
      String(c.failed),
      c.repeated.length === 0 ? 'none' : code(c.repeated),
      c.once.length === 0 ? 'none' : code(c.once),
      c.reasons.length === 0 ? c.verdict : `${c.verdict}: ${c.reasons.join('; ')}`,
    ]);
  }
  return table(
    [
      'Label',
      'Runs with a bad test or lost in the tests',
      'One-sided p against the control',
      'Retries',
      'Flaky',
      'Failed',
      'Bad in two or more arm runs only',
      'Bad in one arm run only',
      'Verdict',
    ],
    rows
  );
}

/** The tolerance phase: a stressed copy of an arm, judged against every control run. */
function toleranceOf(cfg, runs, records) {
  return cfg.tolerance.map((label) => {
    const record = records.find((r) => r.label === label);
    const controlBad = new Set(
      runs
        .filter((r) => r.label === cfg.control && !r.excluded)
        .flatMap((r) => [...r.failedTests, ...r.flakyTests].map(baseName))
    );
    const stressRuns = runs.filter((r) => r.label === label);
    const timed = stressRuns.filter((r) => !r.excluded);
    const failedOnly = uniq(timed.flatMap((r) => r.failedTests.map(baseName))).filter(
      (t) => !controlBad.has(t)
    );
    const flakyOnly = uniq(timed.flatMap((r) => r.flakyTests.map(baseName))).filter(
      (t) => !controlBad.has(t) && !failedOnly.includes(t)
    );
    const lost = stressRuns.filter((r) => r.excluded && r.cause !== 'before-tests').length;
    const verdict =
      failedOnly.length > 0 || lost > 0
        ? 'interference'
        : flakyOnly.length > 0
          ? 'inconclusive'
          : 'no interference';
    return {
      label,
      stressOf: record.arm.stressOf,
      runs: stressRuns.length,
      timed: timed.length,
      lost,
      failedOnly,
      flakyOnly,
      verdict,
    };
  });
}

function renderTolerance(results) {
  if (results.length === 0) return 'No arm has a tolerance phase.';
  return table(
    [
      'Label',
      'Stresses',
      'Runs',
      'Lost inside the tests',
      'Failed, never bad in the control',
      'Only flaky, never bad in the control',
      'Verdict',
    ],
    results.map((t) => [
      `\`${t.label}\``,
      t.stressOf ? `\`${t.stressOf}\`` : 'n/a',
      String(t.runs),
      String(t.lost),
      t.failedOnly.length === 0 ? 'none' : code(t.failedOnly),
      t.flakyOnly.length === 0 ? 'none' : code(t.flakyOnly),
      t.verdict,
    ])
  );
}

/** The S4b simulation of couture-cast, one row per shard count. */
function simulationOf(evidence) {
  const row = evidence.rows.find((r) => r.id === 'sim.couture-cast');
  if (!row) throw new Error('the evidence has no sim.couture-cast row');
  return row.facts;
}

/**
 * The S4b model against the arms. Its per-shard overhead came from S5, before step 0 changed the
 * setup, so the job and machine-time cells use the S6 control's own overhead; the S4b figures stay
 * beside them as a reference.
 */
function renderModel(cfg, runs, records, sim) {
  const control = runs.filter(
    (r) => r.label === cfg.control && r.phase === 'measured' && !r.excluded
  );
  const overhead = median(control.map((r) => r.overheadMs));
  const total = median(control.map((r) => r.balance.total));
  const rows = [];
  for (const label of [cfg.control, ...cfg.arms]) {
    const arm = records.find((r) => r.label === label).arm;
    const timed = runs.filter((r) => r.label === label && !r.excluded && r.phase === 'measured');
    const model = sim.byTest.find((m) => m.shards === arm.shards);
    const why =
      arm.workers !== 1
        ? `the model has one worker per shard, the arm ${arm.workers}`
        : !model
          ? `the model has no row for ${arm.shards} shards`
          : timed.length === 0
            ? 'the arm has no run with timings'
            : null;
    if (why) {
      rows.push([
        `\`${label}\``,
        String(arm.shards),
        String(arm.workers),
        why,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]);
      continue;
    }
    const slowestModel = arm.engine === 'native' ? model.builtinMs : model.balancedMs;
    const s4bOverhead = model.elapsedMs - model.balancedMs;
    const elapsedModel = overhead + slowestModel;
    const machineModel = arm.shards * overhead + total;
    const slowest = median(timed.map((r) => r.balance.slowestBusy));
    const job = median(timed.map((r) => r.slowestJobMs));
    const machine = median(timed.map((r) => r.machineMs));
    rows.push([
      `\`${label}\``,
      String(arm.shards),
      String(arm.workers),
      `${sec(slowestModel)} (${arm.engine === 'native' ? 'built-in split' : 'balanced by test'})`,
      `${sec(slowest)} (${signedPercent(slowest / slowestModel - 1)})`,
      `${sec(s4bOverhead)} / ${sec(median(timed.map((r) => r.overheadMs)))}`,
      sec(model.elapsedMs - model.balancedMs + slowestModel),
      sec(elapsedModel),
      `${sec(job)} (${signedPercent(job / elapsedModel - 1)})`,
      `${sec(model.machineMs)} / ${sec(machineModel)}`,
      `${sec(machine)} (${signedPercent(machine / machineModel - 1)})`,
    ]);
  }
  return table(
    [
      'Label',
      'Shards',
      'Workers',
      'Model: slowest shard in tests',
      'Measured median (departure)',
      'Per-shard overhead, S4b / this arm',
      'S4b model: slowest shard job',
      'Model with the S6 control overhead',
      'Measured slowest shard job (departure)',
      'Model machine time, S4b / S6 overhead',
      'Measured machine time (departure from S6)',
    ],
    rows
  );
}

function setupFigures(runs, records) {
  const timed = runs.filter((r) => !r.excluded);
  const stepValues = timed.flatMap((r) => r.stepTimes[`pw-e2e\u0000${SETUP_STEP}`] || []);
  const versions = joined(
    records
      .filter((r) => !r.collectError)
      .flatMap((r) => r.shards.filter((s) => s.blob).map((s) => s.blob.playwrightVersion))
  );
  return {
    runs: runs.length,
    step: stepValues.length === 0 ? null : median(stepValues),
    before: median(timed.map((r) => r.beforeTestsMs)),
    fixed: median(timed.map((r) => r.decomposition.fixed)),
    slowestJob: median(timed.map((r) => r.slowestJobMs)),
    completion: median(timed.map((r) => r.completion)),
    registry: runs.filter((r) => r.excluded && /toomanyrequests/.test(r.excluded)).length,
    versions,
  };
}

function renderSetup(baselineRuns, baselineRecords, controlRuns, controlRecords) {
  const before = setupFigures(baselineRuns, baselineRecords);
  const after = setupFigures(controlRuns, controlRecords);
  if (before.step === null || after.step === null) {
    throw new Error(`a shard job has no "${SETUP_STEP}" step`);
  }
  const row = (name, key) => [
    name,
    sec(before[key]),
    sec(after[key]),
    secSigned(after[key] - before[key]),
    signedPercent(after[key] / before[key] - 1),
  ];
  return {
    before,
    after,
    table: table(
      ['Measure', `S5 \`${BASELINE_LABEL}\` median`, 'S6 control median', 'Change', 'Change %'],
      [
        ['Playwright', before.versions, after.versions, 'n/a', 'n/a'],
        row(`"${SETUP_STEP}" step, every shard job`, 'step'),
        row('Critical shard before tests', 'before'),
        row('Fixed cost (execution minus the critical shard test span)', 'fixed'),
        row('Slowest shard job', 'slowestJob'),
        row('Completion', 'completion'),
        [
          'Runs lost to `toomanyrequests` / runs',
          `${before.registry} / ${before.runs}`,
          `${after.registry} / ${after.runs}`,
          'n/a',
          'n/a',
        ],
      ]
    ),
  };
}

/** The longest steps of the control's shard jobs before the test step, by median. */
function setupSteps(controlRuns, testStep) {
  const timed = controlRuns.filter((r) => !r.excluded);
  const order = timed[0].stepOrder;
  const testIndex = order.indexOf(testStep);
  return uniq(timed.flatMap((r) => Object.keys(r.stepTimes)))
    .filter((key) => key.startsWith('pw-e2e\u0000'))
    .filter((key) => {
      const index = order.indexOf(key.split('\u0000')[1]);
      return index >= 0 && index < testIndex;
    })
    .map((key) => ({
      step: key.split('\u0000')[1],
      ms: median(timed.flatMap((r) => r.stepTimes[key] || [])),
    }))
    .sort((a, b) => b.ms - a.ms);
}

function renderSteps(steps) {
  return table(
    ['Step before the tests', 'Control median'],
    steps.filter((s) => s.ms >= 1000).map((s) => [s.step, sec(s.ms)])
  );
}

function renderMeaning(cfg, byArm, runs, recordsById, setup, steps, tolerance) {
  const lines = [];
  for (const arm of cfg.arms) {
    const { matched } = byArm[arm];
    const c = correctnessOf(arm, runs, cfg, recordsById);
    const stress = tolerance.filter((t) => t.stressOf === arm);
    if (matched.length === 0) {
      lines.push(`- \`${arm}\` has no matched pair with timings. Correctness: ${c.verdict}.`);
      continue;
    }
    const t = compare(matched, (r) => r.completion);
    const m = compare(matched, (r) => r.machineMs);
    const lead = {
      faster: 'beats the control on completion',
      slower: 'is slower than the control on completion',
      'no detectable difference': 'shows no detectable difference from the control on completion',
    }[t.verdict];
    const correctness =
      c.verdict === 'no regression'
        ? 'Correctness: no regression.'
        : c.verdict === 'inconclusive'
          ? `Correctness: inconclusive, ${c.once.length} test(s) went bad in one arm run and in no control run.`
          : `Correctness: regression, ${c.reasons.join('; ')}.`;
    const parts = [
      `- \`${arm}\` ${lead}: median change within a pair ${secSigned(t.pairedDelta)}, interval ${secSigned(t.interval.low)} to ${secSigned(t.interval.high)} at ${percent(t.interval.coverage)} coverage, faster in ${t.armFaster} of ${matched.length} pairs; the medians are ${sec(t.arm)} against ${sec(t.control)} (${signedPercent(t.ratio)}).`,
      `  Machine time moves ${secSigned(m.pairedDelta)} within a pair (${signedPercent(m.ratio)} on the medians).`,
      `  ${correctness}`,
    ];
    for (const s of stress) {
      parts.push(`  Its tolerance phase \`${s.label}\` (${s.runs} runs) reads: ${s.verdict}.`);
    }
    parts.push(
      `  Against the provisional ${percent(GATE)} gate the change of the medians is ${-t.ratio >= GATE ? 'above' : 'below'} the line.`
    );
    lines.push(parts.join('\n'));
  }
  const control = runs.filter(
    (r) => r.label === cfg.control && r.phase === 'measured' && !r.excluded
  );
  const before = median(control.map((r) => r.beforeTestsMs));
  const completion = median(control.map((r) => r.completion));
  lines.push(
    `- Setup before the first test of the critical shard is ${sec(before)} of the control's ${sec(completion)} median completion (${percent(before / completion)}). Against S5 it moved ${secSigned(setup.after.before - setup.before.before)}.`
  );
  lines.push(
    `- The next setup savings, by control median: ${steps
      .slice(0, NEXT_STEPS)
      .map((s) => `"${s.step}" ${sec(s.ms)}`)
      .join(', ')}.`
  );
  return lines.join('\n');
}

function renderMethod(records) {
  const withEvidence = records.filter((r) => overlapCount(r) !== null);
  const overlapped = withEvidence.filter((r) => overlapCount(r) > 0).length;
  return `## Method

- Every arm is a branch of couture-cast cut from one base commit; the arms table says what each branch changes. The collector proves through the GitHub compare API that each run's commit descends from the base and from the minimum commit, and the dispatcher proves it again for the branch head right before it dispatches.
- The dispatcher starts a run only when no workflow run of the repository is queued or in progress. Afterwards it lists the runs of the repository that overlapped the run: ${overlapped} of ${withEvidence.length} runs with that record overlapped another run, and the runs tables say how many.
- A pair is one control run and one arm run with the same pair number, matched when both have timings and were created at most ${sec(MAX_GAP_MS)} apart. Pair k of the arm at position i in the config runs the control first when k + i is odd, and the completion table counts the pairs in which the control ran first.
- A run that stopped before its test step is replaced within its pair. A run that stopped inside its test step belongs to the shape under test: it is never replaced, it breaks its pair, and it counts in the correctness verdict. A run the collector could not read is kept as a stub with its reason. None of these count in a median.
- The interval for the median change within a pair is distribution free: the k-th smallest to the k-th largest change, with the largest k whose binomial coverage stays at or above ${percent(LEVEL)}. An arm is faster or slower only when the whole interval is.
- Machine time is the sum of the shard job durations. Runner time adds every other job of the run. Time in tests per worker is a shard's time in tests over its worker count.
- The correctness verdict is stated in the correctness table, with the counts it rests on. A test is named by project, file and titles, so a test bad in an arm is matched with the same test in the control.
- The model rows come from the \`sim.couture-cast\` row of the S4b evidence: the built-in split for native arms, the balanced plan for an engine. Its per-shard overhead, everything in a shard job outside the Playwright run, came from S5; the model is also rebuilt with the S6 control's own overhead and median total time in tests, and the departures are taken from that rebuild.
- The setup comparison takes the S5 label measured with the Playwright version printed in its first row. Its runs ran on another day and another commit, so it shows the effect of step 0 together with everything else that changed between the two.
- Warm-up runs fill caches and engine timings before the pairs and count in no comparison. Cache misses count the restore lines of the cache actions that found no entry.
`;
}

function render({ records, baseline, evidence }) {
  if (records.length === 0) throw new Error('no candidate records to render');
  assertCandidates(records);
  const cfg = configOf(records);
  const recordsById = new Map(records.map((r) => [r.run.id, r]));
  const runs = records.map((record) => {
    const analyzed = extend(analyzeRun(record));
    const stepOrder = record.collectError
      ? []
      : record.jobs.find((j) => j.id === record.shards[0].jobId).steps.map((s) => s.name);
    return {
      ...analyzed,
      comparison: record.comparison || null,
      phase: record.arm.phase,
      stepOrder,
    };
  });
  const byArm = pairsByArm(runs, cfg);
  const baselineRecords = baseline.filter((r) => r.label === BASELINE_LABEL);
  if (baselineRecords.length === 0) throw new Error(`no baseline record of ${BASELINE_LABEL}`);
  const baselineRuns = baselineRecords.map((r) => extend(analyzeRun(r)));
  const controlRuns = runs.filter((r) => r.label === cfg.control && r.phase === 'measured');
  const controlRecords = records.filter(
    (r) => r.label === cfg.control && r.arm.phase === 'measured'
  );
  const setup = renderSetup(baselineRuns, baselineRecords, controlRuns, controlRecords);
  const steps = setupSteps(controlRuns, records[0].testStep);
  const sim = simulationOf(evidence);
  const tolerance = toleranceOf(cfg, runs, records);
  const parts = [
    '# couture-cast candidate runs',
    '',
    'More parallelization for the couture-cast Playwright workflow, measured against its current shape: more shards and more workers with native sharding, and duration balancing with the Flakiness reporter. This document is generated by `npm run measurements:candidates` from the raw records in [`raw/candidates/`](raw/candidates/), the S5 records in [`raw/`](raw/) and the S4b simulation evidence. Nothing in it is typed by hand.',
    '',
    '## Arms',
    '',
    renderArms(records, cfg),
    '',
    renderShape(records, cfg),
    '',
    '## Measured runs',
    '',
    'Times are seconds. The critical shard is the shard job that finished last.',
    '',
    renderRuns(runs, 'measured', byArm, recordsById),
    '',
    '### Pairs',
    '',
    renderPairs(cfg, byArm, recordsById),
    '',
    '## Warm-up runs',
    '',
    renderRuns(runs, 'warm-up', byArm, recordsById),
    '',
    '### Engine plan lines',
    '',
    renderEngine(records),
    '',
    '## Completion against the control',
    '',
    renderCompletion(cfg, byArm, runs),
    '',
    '## Cost and where the time went',
    '',
    renderCost(cfg, byArm),
    '',
    renderArmSteps(cfg, runs),
    '',
    '## Correctness',
    '',
    renderCorrectness(cfg, runs, recordsById),
    '',
    '### Tolerance',
    '',
    renderTolerance(tolerance),
    '',
    renderRuns(runs, 'tolerance', byArm, recordsById),
    '',
    '## Model against measurement',
    '',
    renderModel(cfg, runs, records, sim),
    '',
    '## Setup before and after step 0',
    '',
    setup.table,
    '',
    renderSteps(steps),
    '',
    '## What this means for S7',
    '',
    renderMeaning(cfg, byArm, runs, recordsById, setup, steps, tolerance),
    '',
    renderMethod(records),
  ];
  return `${parts.join('\n')}\n`;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`bad argument ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ['raw', 'baseline', 'evidence', 'out']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  const doc = render({
    records: loadRecords(args.raw),
    baseline: loadRecords(args.baseline),
    evidence: JSON.parse(fs.readFileSync(args.evidence, 'utf8')),
  });
  fs.writeFileSync(args.out, doc);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  compare,
  configOf,
  correctnessOf,
  engineCheck,
  parseDuration,
  parseEngine,
  render,
  setupSteps,
};
