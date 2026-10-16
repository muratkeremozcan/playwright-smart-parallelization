'use strict';

/**
 * Proof 2: serial groups and setup or teardown dependencies, with and without history, under
 * fullyParallel, and with a project that needs no setup.
 */

const fs = require('node:fs');
const { coverageKinds, dependencyRow } = require('../../lib/scoring');
const { mixedProject } = require('../../lib/variants');
const { jsonReports } = require('../../lib/artifacts');

/** Titles of the tests that ended unexpectedly, from the JSON reports of a run (empty without). */
function failedTitles(run) {
  const titles = [];
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      if (spec.tests.some((test) => test.status === 'unexpected')) titles.push(spec.title);
    }
    (suite.suites || []).forEach(visit);
  };
  for (const file of jsonReports(run.partition)) {
    JSON.parse(fs.readFileSync(file, 'utf8')).suites.forEach(visit);
  }
  return [...new Set(titles)].sort();
}

function serialRow(id, title, run, extra = {}) {
  const { kinds, groups } = run.summary;
  return {
    id,
    proof: 2,
    title,
    status:
      groups.length === 0 &&
      !kinds['shard-failed'] &&
      Object.keys(coverageKinds(kinds)).length === 0
        ? 'pass'
        : 'fail',
    evidence: {
      splitGroups: groups,
      failedShards: run.summary.shards.filter((shard) => shard.exitCode !== 0).map((s) => s.index),
      coverageViolations: coverageKinds(kinds),
      failedTests: failedTitles(run),
      kinds,
      ...extra,
    },
  };
}

/** Outcome and attempts of every leaf of a serial group, from the shards of a run. */
function serialOutcomes(run) {
  const serial = new Set(
    run.listing.leaves
      .filter((leaf) => leaf.serialGroup && !leaf.dependency)
      .map((leaf) => leaf.key)
  );
  const outcomes = {};
  for (const shard of run.raw) {
    for (const leaf of shard.leaves || []) {
      if (serial.has(leaf.key)) outcomes[leaf.key] = `${leaf.outcome}/${leaf.attempts}`;
    }
  }
  return Object.fromEntries(Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b)));
}

/** Serial groups run the same attempts to the same outcomes as under native sharding. */
function outcomesRow(native, balanced) {
  const expected = serialOutcomes(native);
  const actual = serialOutcomes(balanced);
  const keys = Object.keys(expected);
  const retried = keys.filter((key) => Number(expected[key].split('/')[1]) > 1);
  const same = keys.length > 0 && JSON.stringify(actual) === JSON.stringify(expected);
  const violations = [native, balanced].map((run) => coverageKinds(run.summary.kinds));
  return {
    id: '2.serial-outcomes',
    proof: 2,
    title: 'serial groups end with the outcome and attempts they have under native sharding',
    status:
      same && retried.length > 0 && violations.every((found) => Object.keys(found).length === 0)
        ? 'pass'
        : 'fail',
    evidence: {
      coverageViolations: { native: violations[0], balanced: violations[1] },
      leaves: keys.length,
      leavesWithRetries: retried.length,
      sameOutcomesAsNative: same,
      differing: keys.filter((key) => actual[key] !== expected[key]),
    },
  };
}

/** Counts of dependency (setup, teardown) and primary leaves per shard of a run. */
function shardMix(run) {
  const dependencies = new Set(['setup', 'teardown']);
  return run.raw.map((shard) => ({
    dependencyLeaves: (shard.leaves || []).filter((leaf) => dependencies.has(leaf.project)).length,
    dependentLeaves: (shard.leaves || []).filter((leaf) => leaf.project === 'chromium').length,
    independentLeaves: (shard.leaves || []).filter((leaf) => leaf.project === 'api').length,
  }));
}

/**
 * A config in which one project needs setup and teardown and another does not. A shard with no
 * test of the dependent project must not run them, and the dependent tests together run them once.
 */
function setupAware(ctx) {
  const cwd = mixedProject(ctx);
  const history = ctx.baseline({ name: 'mixed-native', cwd }).history.file;
  const balanced = ctx.run({ name: 'mixed-balanced', cwd, shards: 4, timings: history });
  const native = ctx.run({ name: 'mixed-plain', cwd, shards: 4, plain: true });
  const mix = shardMix(balanced);
  const idle = mix.filter((shard) => shard.dependentLeaves === 0 && shard.dependencyLeaves > 0);
  const { kinds } = balanced.summary;
  return {
    id: '2.setup-aware',
    proof: 2,
    title: 'a shard with no test that needs setup does not run it',
    status:
      idle.length === 0 &&
      !kinds['shard-failed'] &&
      Object.keys(kinds).filter((kind) => kind.startsWith('dependency-')).length === 0 &&
      Object.keys(coverageKinds(kinds)).length === 0
        ? 'pass'
        : 'fail',
    evidence: {
      kinds,
      shards: mix,
      shardsRunningSetupWithoutDependents: idle.length,
      dependencyExecutions: balanced.report.dependencyExecutions,
      nativeShards: shardMix(native),
      nativeDependencyExecutions: native.report.dependencyExecutions,
    },
  };
}

function serialGroups(ctx) {
  const cold = ctx.run({
    name: 'cold-serial',
    shards: 2,
    timings: ctx.coldTimings(),
    json: true,
  });
  const history = ctx.balancedRun(2);
  const three = ctx.balancedRun(3);
  const parallel = ctx.balancedRun(3, { fullyParallel: true });
  const allRuns = [cold, history, three, parallel];
  return [
    serialRow('2.cold', 'no history', cold),
    serialRow('2.history', 'with history, two shards', history),
    serialRow('2.history-3', 'with history, three shards', three),
    serialRow('2.fully-parallel', 'with history, fullyParallel, three shards', parallel),
    outcomesRow(ctx.baseline(), history),
    dependencyRow(allRuns),
    setupAware(ctx),
  ];
}

module.exports = { failedTitles, outcomesRow, serialGroups, serialRow, shardMix };
