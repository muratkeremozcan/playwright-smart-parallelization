'use strict';

/**
 * How the reporter assigns tests (rows `a.*`) and whether every shard computes the same plan
 * (rows `p.*`). Every run goes through the harness, which checks exactly-once coverage, outcomes,
 * serial groups and dependencies; `check` reads the records the same shards wrote.
 */

const fs = require('node:fs');
const path = require('node:path');
const { mixedProject, renamedProject } = require('../../../qualification/lib/variants');
const drive = require('../drive');
const { median } = require('../lib/median');
const { harnessFacts, kindsText, row } = require('./row');

const SLOW_CLOCK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'qualification',
  'lib',
  'slow-clock.js'
);

/** `check` over the records of a run: exit code and problems. */
function checkRun(run, options = {}) {
  const files = run.records.filter(Boolean).map((r) => r.file);
  const call = drive.check(files, options);
  return {
    status: call.status,
    ok: call.json ? call.json.ok : false,
    json: call.json,
    stderr: call.stderr,
  };
}

const strategies = (run) => run.records.map((r) => (r ? r.data.strategy : null));

/** The reporter with no timings file: Playwright's own split on every shard. */
function failOpen(ctx) {
  const open = ctx.run({ name: 'failopen-3', shards: 3 });
  const native = ctx.native(3, { workers: 4 });
  const reasons = open.records.map((r) => (r ? r.data.reason : null));
  const facts = {
    ...harnessFacts(open),
    sameAsNative: drive.sameSplit(open, native),
    strategies: strategies(open),
    reasonsNameMissingFile: reasons.every((reason) => /^no timings file at /.test(reason || '')),
    logLine: ctx.scrub(drive.logLines(open.raw[0].output)[0] || ''),
  };
  return row(
    'a.failopen-native',
    'With no timings file, every shard keeps the split Playwright makes without the reporter.',
    facts.harnessOk &&
      facts.sameAsNative &&
      facts.strategies.every((s) => s === 'builtin') &&
      facts.reasonsNameMissingFile,
    facts,
    `Three shards with the reporter and no timings file ran the same leaves per shard as the same shards without the reporter (same split: ${facts.sameAsNative}). Every record says \`builtin\` and names the missing file, and each shard logs it.`
  );
}

function balancedRow(ctx, shards) {
  const run = ctx.balanced(shards);
  const native = ctx.native(shards);
  const checked = checkRun(run);
  const plan = run.plans[0] || {};
  const facts = {
    ...harnessFacts(run),
    checkExit: checked.status,
    strategies: strategies(run),
    known: plan.known,
    listed: plan.listed,
    shardMs: run.summary.shards.map((s) => s.durationMs),
    slowestMs: run.summary.slowestMs,
    nativeShardMs: native.summary.shards.map((s) => s.durationMs),
    nativeSlowestMs: native.summary.slowestMs,
    imbalance: Number(run.summary.imbalance.toFixed(3)),
    nativeImbalance: Number(native.summary.imbalance.toFixed(3)),
  };
  facts.slowestVsNative = Number((facts.slowestMs / facts.nativeSlowestMs - 1).toFixed(3));
  // The baseline is the same native split run again (reporter present, no timings): the gap
  // between the two native runs is the run-to-run noise of this split on this machine.
  const rerun =
    shards === 2 ? ctx.baseline() : ctx.run({ name: 'builtin-3-w1', shards: 3, workers: 1 });
  facts.nativeRerunSlowestMs = rerun.summary.slowestMs;
  facts.nativeSpread = Number(
    (Math.abs(facts.nativeRerunSlowestMs - facts.nativeSlowestMs) / facts.nativeSlowestMs).toFixed(
      3
    )
  );
  const balancedOk =
    facts.harnessOk && facts.checkExit === 0 && facts.strategies.every((s) => s === 'balanced');
  // Two shards are already even under native sharding on the fixture, so only three must gain.
  const gains = shards === 2 || facts.slowestMs < facts.nativeSlowestMs;
  return row(
    `a.balanced-${shards}`,
    shards === 2
      ? 'Two shards planned from the native records run every leaf once, and `check` passes.'
      : 'Three shards planned from the native records run every leaf once, `check` passes, and the slowest shard is faster than under native sharding.',
    balancedOk && gains,
    facts,
    `One worker per shard, ${facts.known} of ${facts.listed} tests known. Shards took ${facts.shardMs.join(' / ')} ms against ${facts.nativeShardMs.join(' / ')} ms native, slowest ${facts.slowestMs} ms against ${facts.nativeSlowestMs} ms; harness violations ${kindsText(facts.violations)}, \`check\` exit ${facts.checkExit}. A second native run of the same split had its slowest shard at ${facts.nativeRerunSlowestMs} ms.`
  );
}

function repeatEach(ctx) {
  const run = ctx.run({
    name: 'repeat-each-3',
    shards: 3,
    repeatEach: 2,
    timings: ctx.baseline().timings,
  });
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    checkExit: checked.status,
    checkedTests: checked.json && checked.json.tests,
    strategies: strategies(run),
  };
  return row(
    'a.repeat-each',
    'Under `--repeat-each 2` every shard balances, every copy runs once and `check` counts each copy apart.',
    facts.harnessOk && facts.checkExit === 0 && facts.strategies.every((s) => s === 'balanced'),
    facts,
    `Three shards, \`--repeat-each 2\`: harness violations ${kindsText(facts.violations)}; \`check\` counted ${facts.checkedTests} distinct tests and exited ${facts.checkExit}, because a repeat carries its own suffix in the record.`
  );
}

function fullyParallel(ctx) {
  const run = ctx.balanced(3, { fullyParallel: true });
  const native = ctx.native(3, { fullyParallel: true });
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    checkExit: checked.status,
    granularity: run.records.map((r) => r && r.data.granularity),
    slowestMs: run.summary.slowestMs,
    nativeSlowestMs: native.summary.slowestMs,
  };
  return row(
    'a.fully-parallel',
    'Under `fullyParallel` the plan splits by test, keeps every serial group whole and runs every leaf once.',
    facts.harnessOk && facts.checkExit === 0 && facts.granularity.every((g) => g === 'auto'),
    facts,
    `\`fullyParallel\`, three shards, one worker: harness violations ${kindsText(facts.violations)}, records say granularity \`auto\`, slowest shard ${facts.slowestMs} ms against ${facts.nativeSlowestMs} ms native.`
  );
}

/** How many project and spec file pairs of a run ran on more than one shard (setup aside). */
function filesWhole(run) {
  const dependency = new Set(run.listing.leaves.filter((l) => l.dependency).map((l) => l.key));
  const where = new Map();
  run.raw.forEach((shard) => {
    for (const leaf of shard.leaves || []) {
      if (dependency.has(leaf.key)) continue;
      const key = `${leaf.project} ${leaf.file}`;
      where.set(key, new Set([...(where.get(key) || []), shard.index]));
    }
  });
  return [...where.values()].filter((set) => set.size > 1).length;
}

function granularityFile(ctx) {
  const run = ctx.run({
    name: 'granularity-file-3',
    shards: 3,
    timings: ctx.baseline().timings,
    granularity: 'file',
    workers: 1,
    fullyParallel: true,
  });
  const facts = {
    ...harnessFacts(run),
    splitFiles: filesWhole(run),
    granularity: run.records.map((r) => r && r.data.granularity),
    slowestMs: run.summary.slowestMs,
  };
  return row(
    'a.granularity-file',
    'With `granularity: file` every spec file stays on one shard, also under `fullyParallel`; that grouping reads no `_parallelMode`, while the reporter still reads `_locks`.',
    facts.harnessOk && facts.splitFiles === 0 && facts.granularity.every((g) => g === 'file'),
    facts,
    `\`fullyParallel\` with \`granularity: file\`, three shards: ${facts.splitFiles} files split across shards, harness violations ${kindsText(facts.violations)}, slowest shard ${facts.slowestMs} ms.`
  );
}

function renamed(ctx) {
  const run = ctx.run({
    name: 'renamed-2',
    cwd: renamedProject(ctx),
    shards: 2,
    timings: ctx.baseline().timings,
  });
  const checked = checkRun(run);
  const plan = run.plans[0] || {};
  const facts = {
    ...harnessFacts(run),
    checkExit: checked.status,
    known: plan.known,
    listed: plan.listed,
  };
  facts.unknown = facts.listed - facts.known;
  return row(
    'a.renamed',
    'A renamed test and a new file run, and the plan counts them as unknown.',
    facts.harnessOk && facts.checkExit === 0 && facts.unknown === 6,
    facts,
    `One test renamed and a new file of two tests, in both browser projects: every leaf ran once, and the plan line says ${facts.known}/${facts.listed} tests known, so ${facts.unknown} are priced by estimate.`
  );
}

/** The setup project's leaves a shard ran. */
const ranSetup = (shard) => (shard.leaves || []).some((leaf) => leaf.project === 'setup');

function setupAware(ctx) {
  const cwd = mixedProject(ctx);
  const baseline = ctx.baseline({ name: 'mixed-native', cwd });
  const run = ctx.run({
    name: 'mixed-balanced-3',
    cwd,
    shards: 3,
    timings: baseline.timings,
    workers: 1,
  });
  const list = drive.listReport({
    cwd,
    config: ctx.config(cwd),
    file: path.join(ctx.dir('mixed-list'), 'list.json'),
  });
  const sim = drive.simulate({ timings: baseline.timings, list, shards: 3, workers: 1 });
  if (!sim.json) throw new Error(`simulate failed: ${sim.stderr}`);
  const setupMs = Object.values(sim.json.setup_ms).reduce((a, b) => a + b, 0);
  const timings = drive.readTimings(baseline.timings).tests;
  const price = (key) => median(timings[key].samples);
  const shards = run.records.map((r, i) => {
    const { predicted_ms: predicted, shard } = r.data;
    const work = r.data.tests.filter((t) => !t.setup).reduce((sum, t) => sum + price(t.key), 0);
    return {
      shard: shard.current,
      ranSetup: ranSetup(run.raw[i]),
      hostsDependent: r.data.tests.some((t) => t.key.startsWith('[chromium]')),
      predictedMs: predicted[shard.current - 1],
      workMs: work,
    };
  });
  const consistent = shards.every(
    (s) =>
      s.ranSetup === s.hostsDependent &&
      s.predictedMs - s.workMs === (s.hostsDependent ? setupMs : 0)
  );
  const facts = {
    ...harnessFacts(run),
    setupMs,
    shards,
    consistent,
    setupShards: shards.filter((s) => s.ranSetup).length,
  };
  const setupList = shards
    .filter((x) => x.ranSetup)
    .map((x) => x.shard)
    .join(' and ');
  return row(
    'a.setup-aware',
    'Only the shards that host a test needing setup run it, and the predicted time of exactly those shards includes the setup cost.',
    facts.harnessOk && consistent && facts.setupShards > 0 && facts.setupShards < shards.length,
    facts,
    `Only \`chromium\` depends on setup, three shards: the shards that ran setup (${setupList}) are exactly the shards that host a \`chromium\` test. Each predicted time equals its work plus ${setupMs} ms of setup and teardown on those shards and its work alone on the others (${consistent}); harness violations ${kindsText(facts.violations)}.`
  );
}

function logLine(ctx) {
  const run = ctx.balanced(3);
  const plans = run.plans;
  const facts = {
    linesPerShard: run.raw.map((shard) => drive.logLines(shard.output).length),
    samePlanSha: new Set(plans.map((p) => p && p.planSha)).size === 1,
    sameTimingsSha: new Set(plans.map((p) => p && p.timingsSha)).size === 1,
    planSha: plans[0] && plans[0].planSha,
    timingsSha: plans[0] && plans[0].timingsSha,
    example: drive.logLines(run.raw[0].output)[0],
  };
  return row(
    'a.log-line',
    'Each balanced shard logs one line with its files, tests, estimate, the range of all shards, the timings sha and the plan sha.',
    plans.every(Boolean) &&
      facts.linesPerShard.every((n) => n === 1) &&
      facts.samePlanSha &&
      facts.sameTimingsSha,
    facts,
    `Every shard printed ${facts.linesPerShard[0]} line, all with timings \`${facts.timingsSha}\` and plan \`${facts.planSha}\`, for example: \`${facts.example}\`.`
  );
}

/** The plan sha a shard logs when it only lists its tests. */
function listedPlan(ctx, { shard, timings, workers = 1, env = {} }) {
  const listed = drive.playwright({
    cwd: ctx.cwd,
    args: ['--list', `--config=${ctx.config()}`, `--shard=${shard}`, `--workers=${workers}`],
    env: { PSP_PSB_TIMINGS: timings, ...env },
  });
  const plan = drive.logLines(listed.output).map(drive.parsePlanLine).find(Boolean);
  if (!plan) throw new Error(`shard ${shard} listed no plan: ${listed.output.slice(0, 300)}`);
  return plan.planSha;
}

function copiesSamePlan(ctx) {
  const copies = [1, 2, 3].map((index) => ctx.timingsCopy(`copy-${index}`));
  const run = ctx.run({
    name: 'copies-3',
    shards: 3,
    shard: (index) => ({ env: { PSP_PSB_TIMINGS: copies[index - 1] } }),
  });
  const reference = ctx.balanced(3).plans[0].planSha;
  const facts = {
    ...harnessFacts(run),
    identicalBytes: new Set(copies.map((file) => fs.readFileSync(file, 'utf8'))).size === 1,
    planShas: run.plans.map((p) => p && p.planSha),
    referencePlanSha: reference,
  };
  return row(
    'p.copies-same-plan',
    'Shards that read byte-identical copies of the timings file compute the same plan.',
    facts.harnessOk && facts.identicalBytes && facts.planShas.every((sha) => sha === reference),
    facts,
    `Three shards, each reading its own copy of the same bytes, logged plan ${[...new Set(facts.planShas)].map((s) => `\`${s}\``).join(', ')}, the plan of the run that shared one file; harness violations ${kindsText(facts.violations)}.`
  );
}

function workersIndependent(ctx) {
  const timings = ctx.baseline().timings;
  const shas = {};
  for (const workers of [1, 4]) {
    shas[workers] = [1, 2, 3].map((index) =>
      listedPlan(ctx, { shard: `${index}/3`, timings, workers })
    );
  }
  const facts = { planShasWorkers1: shas[1], planShasWorkers4: shas[4] };
  return row(
    'p.workers-independent',
    "The plan does not depend on Playwright's `--workers`: the reporter packs for its own `workers` option.",
    new Set([...shas[1], ...shas[4]]).size === 1,
    facts,
    `\`--list\` of the three shards with \`--workers=1\` and with \`--workers=4\` logged plan ${[...new Set([...shas[1], ...shas[4]])].map((s) => `\`${s}\``).join(', ')}.`
  );
}

function slowClock(ctx) {
  const timings = ctx.baseline().timings;
  const normal = [1, 2, 3].map((index) => listedPlan(ctx, { shard: `${index}/3`, timings }));
  const slow = [1, 2, 3].map((index) =>
    listedPlan(ctx, {
      shard: `${index}/3`,
      timings,
      env: { NODE_OPTIONS: `--require ${SLOW_CLOCK}` },
    })
  );
  const facts = { planShas: normal, slowClockPlanShas: slow };
  return row(
    'p.slow-clock',
    'With a clock that jumps a second on every read, every shard computes the same plan as without it.',
    new Set([...normal, ...slow]).size === 1,
    facts,
    `With a clock that runs one second ahead on every read, the three shards logged plan ${[...new Set(slow)].map((s) => `\`${s}\``).join(', ')}, against ${[...new Set(normal)].map((s) => `\`${s}\``).join(', ')} without it.`
  );
}

function assignmentRows(ctx) {
  return [
    failOpen(ctx),
    balancedRow(ctx, 2),
    balancedRow(ctx, 3),
    repeatEach(ctx),
    fullyParallel(ctx),
    granularityFile(ctx),
    renamed(ctx),
    logLine(ctx),
    setupAware(ctx),
  ];
}

function planRows(ctx) {
  return [copiesSamePlan(ctx), workersIndependent(ctx), slowClock(ctx)];
}

module.exports = { assignmentRows, checkRun, filesWhole, listedPlan, planRows, strategies };
