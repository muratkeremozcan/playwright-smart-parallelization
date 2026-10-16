'use strict';

/**
 * Proofs 4 and 5: every shard computes the same assignment, and corrupt or mismatched input
 * cannot split the shards. The engine plans inside each shard from its own copy of the timings
 * file, so these checks list the shards (`--list`, which plans exactly as a run does) and run
 * shards that were given different input.
 */

const fs = require('node:fs');
const path = require('node:path');
const { checkCoverage } = require('../../../harness/checks');
const { copyProject } = require('../../lib/project');
const { coverageKinds } = require('../../lib/scoring');
const { partitionOf, mapDurations, testDurations } = require('../drive');
const { listShard, parsePlan, scrub } = require('../playwright');

const SLOW_CLOCK = path.resolve(__dirname, '..', '..', 'lib', 'slow-clock.js');

/** The first `Error:` line of an output, with each path reduced to its file name. */
function firstError(output) {
  return scrub((output.match(/^Error: .*$/m) || [''])[0]).slice(0, 200);
}

function countKinds(violations) {
  const counts = {};
  for (const violation of violations) counts[violation.kind] = (counts[violation.kind] || 0) + 1;
  return counts;
}

/**
 * Lists every shard of a `shards`-way split. `timings` is one file for all shards or an array
 * with one file per shard. Returns the listings and the coverage violations of their union.
 */
function listAll(ctx, { timings, shards, env = {}, args = [], cwd = ctx.cwd }) {
  const listing = ctx.listing({ cwd });
  const listed = Array.from({ length: shards }, (_, position) => {
    const file = Array.isArray(timings) ? timings[position] : timings;
    return listShard({
      cwd,
      config: ctx.config(cwd),
      shard: `${position + 1}/${shards}`,
      env: { PSP_FLK_TIMINGS: file, FLAKINESS_OUTPUT_DIR: ctx.reportDir('listing'), ...env },
      args,
    });
  });
  const violations = checkCoverage(
    listing.leaves,
    listed.map((shard, position) => ({
      index: position + 1,
      exitCode: shard.exitCode,
      leaves: shard.leaves || [],
    }))
  );
  return { listed, kinds: coverageKinds(countKinds(violations)) };
}

/** The primary leaf keys of each shard of a listing or a run, sorted. */
function placement(shardLeaves, listing) {
  const primary = new Set(
    listing.leaves.filter((leaf) => !leaf.dependency).map((leaf) => leaf.key)
  );
  return shardLeaves.map((leaves) =>
    (leaves || [])
      .map((leaf) => leaf.key)
      .filter((key) => primary.has(key))
      .sort()
  );
}

/** A run in which every leaf ran to a result: no missing, repeated or skipped leaf. */
function cleanRun(run) {
  return Object.keys(coverageKinds(run.summary.kinds)).length === 0;
}

function plansOf(listed) {
  return listed.map((shard) => parsePlan(shard.output));
}

/** One plan per run is the same plan: the loads line is the plan's fingerprint. */
function loadsOf(plans) {
  return [...new Set(plans.map((plan) => plan && plan.loads))];
}

function deterministicPlan(ctx) {
  const timings = ctx.baseline().history.file;
  const listing = ctx.listing();
  const variants = [
    { name: 'first', env: {}, args: ['--workers=1'] },
    { name: 'again', env: {}, args: ['--workers=1'] },
    { name: 'four workers', env: {}, args: ['--workers=4'] },
    {
      name: 'slow clock',
      env: { NODE_OPTIONS: `--require "${SLOW_CLOCK}"` },
      args: ['--workers=1'],
    },
  ];
  const runs = variants.map((variant) => ({
    variant: variant.name,
    ...listAll(ctx, { timings, shards: 3, env: variant.env, args: variant.args }),
  }));
  const placements = runs.map((run) =>
    JSON.stringify(
      placement(
        run.listed.map((shard) => shard.leaves),
        listing
      )
    )
  );
  const loads = loadsOf(runs.flatMap((run) => plansOf(run.listed)));
  const violations = runs.flatMap((run) => Object.keys(run.kinds));
  return {
    id: '4.deterministic-plan',
    proof: 4,
    title: 'every shard, repeat, worker count and clock gets the same plan',
    status:
      new Set(placements).size === 1 && loads.length === 1 && loads[0] && violations.length === 0
        ? 'pass'
        : 'fail',
    evidence: {
      runs: runs.map((run) => run.variant),
      distinctPlacements: new Set(placements).size,
      distinctPlanLines: loads.length,
      plan: plansOf(runs[0].listed)[0],
      coverageViolations: violations,
    },
  };
}

function listMatchesRun(ctx) {
  const run = ctx.balancedRun(2);
  const timings = ctx.baseline().history.file;
  const { listed } = listAll(ctx, { timings, shards: 2 });
  const ran = placement(
    run.raw.map((shard) => shard.leaves),
    run.listing
  );
  const planned = placement(
    listed.map((shard) => shard.leaves),
    run.listing
  );
  return {
    id: '4.list-matches-run',
    proof: 4,
    title: '--list of a shard shows the tests the shard runs',
    status: JSON.stringify(ran) === JSON.stringify(planned) && cleanRun(run) ? 'pass' : 'fail',
    evidence: {
      leavesPerShard: ran.map((keys) => keys.length),
      sameAsRun: JSON.stringify(ran) === JSON.stringify(planned),
    },
  };
}

/** The reporter, not Playwright, replaces the native split: execution shows both. */
function appliedByReporter(ctx) {
  const native = ctx.baseline();
  const plain = ctx.run({ name: 'plain-2', shards: 2, plain: true, workers: 1 });
  const balanced = ctx.balancedRun(2);
  const keys = (run) =>
    placement(
      run.raw.map((shard) => shard.leaves),
      run.listing
    );
  const nativeKeys = keys(native);
  const differs = JSON.stringify(keys(balanced)) !== JSON.stringify(nativeKeys);
  const sameAsPlain = JSON.stringify(keys(plain)) === JSON.stringify(nativeKeys);
  return {
    id: '4.applied-by-reporter',
    proof: 4,
    title: 'the reporter replaces the native split; without a timings file the split is native',
    status: differs && sameAsPlain && [native, plain, balanced].every(cleanRun) ? 'pass' : 'fail',
    evidence: {
      balancedDiffersFromNative: differs,
      reporterWithoutTimingsEqualsPlainNative: sameAsPlain,
      nativeLeavesPerShard: nativeKeys.map((list) => list.length),
      balancedLeavesPerShard: keys(balanced).map((list) => list.length),
    },
  };
}

/** A copy of a timings file in which every duration is zero, checked before it is used. */
function zeroed(good, output) {
  mapDurations(good, () => 0, output);
  for (const [test, duration] of testDurations(output)) {
    if (duration !== 0) throw new Error(`${test} still takes ${duration} ms in the zeroed file`);
  }
  return output;
}

/** Timings files derived from a good one, one set per kind of damage. */
function timingVariants(ctx) {
  const dir = ctx.dir('damaged');
  const good = ctx.baseline().history.file;
  const source = fs.readFileSync(good, 'utf8');
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const parsed = JSON.parse(source);
  const stale = JSON.parse(source);
  for (const suite of stale.suites) suite.title = `old-${suite.title}`;
  return {
    truncated: [
      write('truncated.json', source.slice(0, 300)),
      write('empty.json', ''),
      path.join(dir, 'absent.json'),
    ],
    version: [
      write('old-version.json', { version: 1, tests: {} }),
      write('array.json', []),
      write('null.json', 'null'),
    ],
    nullTests: [
      write('null-tests.json', { ...parsed, suites: null }),
      write('string-suites.json', { ...parsed, suites: 'none' }),
    ],
    stringDurations: [mapDurations(good, () => 'abc', path.join(dir, 'string-durations.json'))],
    zeroDurations: [zeroed(good, path.join(dir, 'zero-durations.json'))],
    staleIds: [write('stale-ids.json', stale)],
  };
}

/**
 * What a split with damaged input did: every shard failed before it listed any test, every shard
 * got a plan that covers each test once (`kinds` holds no coverage violation), or neither.
 */
function classifyListing(listed, kinds) {
  if (listed.every((shard) => shard.exitCode !== 0 && (shard.leaves || []).length === 0)) {
    return 'fails before any test';
  }
  if (listed.every((shard) => shard.exitCode === 0) && Object.keys(kinds).length === 0) {
    return 'complete plan';
  }
  return 'incomplete';
}

/**
 * One damaged-input row. The engine is safe for this input when it either fails every shard
 * before any test runs or gives every shard a plan that covers each test once. `silent` marks a
 * plan built on the input although the input told the planner nothing: no error, exit 0.
 */
function damagedRow(ctx, id, title, files) {
  const outcomes = files.map((file) => {
    const { listed, kinds } = listAll(ctx, { timings: file, shards: 2 });
    const plan = plansOf(listed)[0];
    const outcome = classifyListing(listed, kinds);
    return {
      file: path.basename(file),
      outcome,
      exits: listed.map((shard) => shard.exitCode),
      message: outcome === 'fails before any test' ? firstError(listed[0].output) : '',
      silent: outcome === 'complete plan',
      hinted: plan ? plan.hinted : null,
      tests: plan ? plan.tests : null,
      loads: plan ? plan.loads : null,
      coverageViolations: kinds,
    };
  });
  return {
    id,
    proof: 5,
    title,
    status: outcomes.every((outcome) => outcome.outcome !== 'incomplete') ? 'pass' : 'fail',
    evidence: { outcomes },
  };
}

function damagedTiming(ctx) {
  const variants = timingVariants(ctx);
  return [
    damagedRow(ctx, '5.truncated', 'truncated, empty or missing timings file', variants.truncated),
    damagedRow(ctx, '5.version', 'valid JSON that is not a Flakiness report', variants.version),
    damagedRow(
      ctx,
      '5.null-tests',
      'a report whose suites value is null or text',
      variants.nullTests
    ),
    damagedRow(ctx, '5.string-durations', 'durations stored as text', variants.stringDurations),
    damagedRow(ctx, '5.zero-durations', 'every duration zero', variants.zeroDurations),
    damagedRow(ctx, '5.stale-ids', 'timings for tests that no longer exist', variants.staleIds),
  ];
}

/** The project is not a git repository: the reporter reads the commit before it plans. */
function noGitRepository(ctx) {
  const cwd = copyProject(ctx.cwd, ctx.dir('no-git'));
  // The ceiling stops git from finding a repository above the copy.
  const { listed, kinds } = listAll(ctx, {
    timings: ctx.baseline().history.file,
    shards: 2,
    cwd,
    env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
  });
  const outcome = classifyListing(listed, kinds);
  return {
    id: '5.no-git-repository',
    proof: 5,
    title: 'the project is not a git repository',
    status: outcome === 'incomplete' ? 'fail' : 'pass',
    evidence: {
      outcome,
      exits: listed.map((shard) => shard.exitCode),
      message: firstError(listed[0].output),
    },
  };
}

/** Real runs where one shard (or all) is configured differently from the others. */
function splitShards(ctx) {
  const baseline = ctx.baseline();
  const timings = baseline.history.file;
  const dir = ctx.dir('split');
  const base = (name) => partitionOf({ shards: 2, dir: ctx.dir(name), timings });

  const other = mapDurations(
    timings,
    (() => {
      let n = 0;
      return () => 100 + ((n++ * 37) % 900);
    })(),
    path.join(dir, 'other-timings.json')
  );
  const mismatched = base('mismatched-timings');
  mismatched[1].env.PSP_FLK_TIMINGS = other;
  const mismatch = ctx.runPartition({ name: 'mismatched-timings', partition: mismatched });

  const damaged = base('damaged-shard');
  damaged[1].env.PSP_FLK_TIMINGS = path.join(dir, 'damaged.json');
  fs.writeFileSync(damaged[1].env.PSP_FLK_TIMINGS, fs.readFileSync(timings, 'utf8').slice(0, 300));
  const broken = ctx.runPartition({ name: 'damaged-shard', partition: damaged });

  const dropped = base('reporter-dropped');
  dropped[1].args.push('--reporter=list');
  const mixed = ctx.runPartition({ name: 'reporter-dropped', partition: dropped });

  const overridden = base('reporter-overridden').map((shard) => ({
    ...shard,
    args: [...shard.args, '--reporter=list'],
  }));
  const allOverridden = ctx.runPartition({ name: 'reporter-overridden', partition: overridden });

  const plain = ctx.run({ name: 'plain-2', shards: 2, plain: true, workers: 1 });
  const keys = (run) =>
    placement(
      run.raw.map((shard) => shard.leaves),
      run.listing
    );
  const planned = (run) => run.raw.map((shard) => parsePlan(shard.output) !== null);

  const damagedShard = broken.raw[1];
  const planLinesDiffer =
    loadsOf([parsePlan(mismatch.raw[0].output), parsePlan(mismatch.raw[1].output)]).length > 1;
  return [
    {
      id: '5.mismatched-timings',
      proof: 5,
      title: 'shard 2 reads a valid timings file that differs from the one shard 1 reads',
      status: Object.keys(coverageKinds(mismatch.kinds)).length === 0 ? 'pass' : 'fail',
      evidence: {
        coverageViolations: coverageKinds(mismatch.kinds),
        exits: mismatch.raw.map((shard) => shard.exitCode),
        planLinesDiffer,
      },
    },
    {
      id: '5.reporter-dropped',
      proof: 5,
      title: 'the command line of shard 2 replaces the config reporters',
      status: Object.keys(coverageKinds(mixed.kinds)).length === 0 ? 'pass' : 'fail',
      evidence: {
        coverageViolations: coverageKinds(mixed.kinds),
        exits: mixed.raw.map((shard) => shard.exitCode),
        planPrintedPerShard: planned(mixed),
      },
    },
    {
      id: '5.reporter-overridden',
      proof: 5,
      title: 'the command line of every shard replaces the config reporters',
      status: Object.keys(coverageKinds(allOverridden.kinds)).length === 0 ? 'pass' : 'fail',
      evidence: {
        coverageViolations: coverageKinds(allOverridden.kinds),
        exits: allOverridden.raw.map((shard) => shard.exitCode),
        planPrintedPerShard: planned(allOverridden),
        splitIsNative: JSON.stringify(keys(allOverridden)) === JSON.stringify(keys(plain)),
        silent: allOverridden.raw.every((shard) => shard.exitCode === 0),
      },
    },
    {
      id: 'x1.damaged-shard-timings',
      proof: 'x1',
      title: 'shard 2 reads a truncated timings file while shard 1 reads the good one',
      status:
        damagedShard.exitCode !== 0 &&
        (damagedShard.leaves || []).length === 0 &&
        !broken.kinds.duplicate &&
        !broken.kinds.unexpected &&
        !broken.kinds['not-executed']
          ? 'pass'
          : 'fail',
      evidence: {
        exits: broken.raw.map((shard) => shard.exitCode),
        leavesRunPerShard: broken.raw.map((shard) => (shard.leaves || []).length),
        kinds: broken.kinds,
        message: firstError(damagedShard.output),
      },
    },
  ];
}

module.exports = {
  appliedByReporter,
  classifyListing,
  damagedTiming,
  deterministicPlan,
  firstError,
  listAll,
  listMatchesRun,
  noGitRepository,
  placement,
  splitShards,
};
