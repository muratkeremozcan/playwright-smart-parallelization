'use strict';

/**
 * Proof 7: a run with no history executes the full intended suite, and a renamed or new test is
 * kept and shows up as an estimate.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildHistory, reportFiles } = require('../drive');
const { mergeTiming } = require('../engine');
const { renamedProject } = require('../variants');
const { coverageKinds } = require('./coverage');

const RENAMED_FROM = 'cart.spec.js::cart::adds an item';
const RENAMED_TO = 'cart.spec.js::cart::adds one item';
const NEW_TESTS = [
  'wishlist.spec.js::wishlist::adds a product',
  'wishlist.spec.js::wishlist::shares the list',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assignmentsOf(run) {
  return Object.values(run.planned.assignments).map((call) => call.assignment);
}

function estimatedIds(run) {
  return [...new Set(assignmentsOf(run).flatMap((assignment) => assignment.estimatedTests))].sort();
}

function newTests(ctx) {
  const cold = ctx.engineRun({ name: 'merged-cold', flow: 'merged', shards: 2 });
  const coldAssignments = assignmentsOf(cold);

  const baseline = ctx.baseline();
  const cwd = renamedProject(ctx);
  const run = ctx.engineRun({
    name: 'renamed',
    cwd,
    flow: 'merged',
    shards: 2,
    timing: baseline.history.timing,
    reports: {},
  });
  const listing = ctx.listing({ cwd });
  const dir = ctx.dir('renamed-merge');
  const existing = baseline.history.timing.chromium;
  const { timing } = buildHistory({
    dir,
    reports: reportFiles(run.partition),
    listing,
    existing: { chromium: existing },
  });
  const merged = readJson(timing.chromium);

  const currentIds = [
    ...new Set(
      listing.leaves
        .filter((leaf) => leaf.project === 'chromium' || leaf.dependency)
        .map((leaf) => [leaf.file, ...leaf.titlePath].join('::'))
    ),
  ];
  const currentTests = path.join(dir, 'current-tests.txt');
  fs.writeFileSync(currentTests, `${currentIds.join('\n')}\n`);
  const pruned = path.join(dir, 'pruned.json');
  const prune = mergeTiming({
    existing,
    artifacts: [path.join(dir, 'timing-chromium-shard-1.json')],
    output: pruned,
    currentTests,
  });

  const estimated = estimatedIds(run);
  const found = coverageKinds(run.summary.kinds);
  const visible = [RENAMED_TO, ...NEW_TESTS].every((id) => estimated.includes(id));
  return [
    {
      id: '7.cold',
      proof: 7,
      title: 'no history: the full intended suite runs',
      status: Object.keys(coverageKinds(cold.summary.kinds)).length === 0 ? 'pass' : 'fail',
      evidence: {
        coverageViolations: coverageKinds(cold.summary.kinds),
        testsPlanned: coldAssignments.reduce((sum, a) => sum + a.totalTests, 0),
        testsEstimated: coldAssignments.reduce((sum, a) => sum + a.estimatedTests.length, 0),
      },
    },
    {
      id: '7.new-renamed',
      proof: 7,
      title: 'history from before a rename and a new file of two tests',
      status: Object.keys(found).length === 0 && visible ? 'pass' : 'fail',
      evidence: {
        coverageViolations: found,
        estimatedTests: estimated,
        staleEntryKeptAfterMerge: RENAMED_FROM in merged.tests,
        staleEntryPrunedWithCurrentTests:
          prune.status === 0 && !(RENAMED_FROM in readJson(pruned).tests),
        newEntriesAfterMerge: [RENAMED_TO, ...NEW_TESTS].filter((id) => id in merged.tests).length,
      },
    },
  ];
}

module.exports = { newTests };
