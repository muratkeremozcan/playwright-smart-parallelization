'use strict';

/**
 * Proof 2: serial groups and setup or teardown dependencies, with and without history and with
 * every file-affinity setting the engine offers.
 */

const fs = require('node:fs');
const { coverageKinds } = require('./coverage');
const { reportFiles } = require('../drive');

/** Titles of the tests that ended unexpectedly, from the JSON reports of a run (empty without). */
function failedTitles(run) {
  const titles = [];
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      if (spec.tests.some((test) => test.status === 'unexpected')) titles.push(spec.title);
    }
    (suite.suites || []).forEach(visit);
  };
  for (const file of reportFiles(run.partition)) {
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

/** Setup and teardown run once in every shard that needs them, in every run, and nothing skipped. */
function dependencyRow(runs) {
  const violations = runs.flatMap((run) =>
    Object.keys(run.summary.kinds).filter(
      (kind) => kind.startsWith('dependency-') || kind === 'not-executed'
    )
  );
  return {
    id: '2.dependencies',
    proof: 2,
    title: 'setup and teardown run once per shard that needs them',
    status: violations.length === 0 ? 'pass' : 'fail',
    evidence: {
      runsChecked: runs.length,
      dependencyViolations: violations,
      dependencyExecutions: runs.map((run) => run.report.dependencyExecutions),
    },
  };
}

function serialGroups(ctx) {
  const timing = ctx.baseline().history.timing;
  const cold = ctx.engineRun({ name: 'merged-cold', flow: 'merged', shards: 2 });
  const history = ctx.engineHistoryRun(2);
  const noAffinity = ctx.engineRun({
    name: 'merged-no-affinity',
    flow: 'merged',
    shards: 2,
    timing,
    assign: { fileAffinity: false },
    reports: {},
  });
  const huge = ctx.engineRun({
    name: 'merged-huge-penalty',
    flow: 'merged',
    shards: 2,
    timing,
    assign: { penalty: 100000000 },
    reports: {},
  });
  const combined = ctx.engineRun({ name: 'combined-cold', flow: 'combined', shards: 2 });
  const allRuns = [cold, history, noAffinity, huge, combined];
  return [
    serialRow('2.cold', 'no history, default file affinity', cold),
    serialRow('2.history', 'with history, default file affinity', history),
    serialRow('2.no-affinity', 'with history, --no-file-affinity', noAffinity),
    serialRow('2.huge-penalty', 'with history, --file-affinity-penalty 100000000', huge),
    ...groupedRows(ctx),
    dependencyRow(allRuns),
  ];
}

/** Integration evidence: the same runs with serial groups handed to the engine as one test. */
function groupedRows(ctx) {
  const cold = ctx.engineRun({ name: 'grouped-cold', flow: 'grouped', shards: 2 });
  const two = ctx.engineHistoryRun(2, 'grouped');
  const three = ctx.engineHistoryRun(3, 'grouped');
  return [
    {
      ...serialRow('2.grouped-cold', 'serial groups as one test, no history', cold),
      subject: 'integration',
    },
    {
      ...serialRow('2.grouped-history-2', 'serial groups as one test, history, 2 shards', two),
      subject: 'integration',
    },
    {
      ...serialRow('2.grouped-history-3', 'serial groups as one test, history, 3 shards', three),
      subject: 'integration',
    },
  ];
}

module.exports = { dependencyRow, serialGroups, serialRow };
