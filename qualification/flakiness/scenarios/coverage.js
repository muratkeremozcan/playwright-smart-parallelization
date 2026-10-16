'use strict';

/**
 * Proofs 1, 3 and 7: exactly-once coverage, filters and project selection, no history and new or
 * renamed tests. Each function takes the shared context and returns proof rows.
 */

const { coverageKinds, coverageRow } = require('../../lib/scoring');
const { prefixProject, renamedProject, siblingsProject } = require('../../lib/variants');
const { buildHistory, flakinessReports } = require('../drive');
const { listShard, parsePlan } = require('../playwright');
const { classifyListing, firstError } = require('./assignment');

/** The plan the first shard of a run printed. */
function planOf(run) {
  return parsePlan(run.raw[0].output);
}

/** Leaves of the intended set that need no dependency project. */
function intendedCount(run) {
  return run.listing.leaves.filter((leaf) => !leaf.dependency).length;
}

function exactlyOnce(ctx) {
  const timings = ctx.baseline().history.file;
  const balanced = ctx.run({ name: 'balanced-2-w4', shards: 2, timings, json: true });
  const repeat = ctx.run({ name: 'repeat-each', shards: 3, repeatEach: 2, timings });
  const parallel = ctx.run({
    name: 'fully-parallel-3',
    shards: 3,
    timings,
    fullyParallel: true,
  });
  const cold = ctx.coldTimings();
  const prefix = ctx.run({
    name: 'prefix-titles',
    cwd: prefixProject(ctx),
    shards: 2,
    timings: cold,
  });
  const siblings = ctx.run({
    name: 'sibling-suites',
    cwd: siblingsProject(ctx),
    shards: 2,
    timings: cold,
  });

  const siblingRow = coverageRow(
    '1.sibling-suites',
    1,
    'two sibling serial suites registered by one function',
    siblings,
    {
      leavesListed: intendedCount(siblings),
      leavesRun: siblings.summary.shards.reduce((sum, shard) => sum + shard.leafCount, 0),
      splitGroups: siblings.summary.groups,
    }
  );
  const whole =
    siblingRow.status === 'pass' &&
    siblingRow.evidence.leavesListed === siblingRow.evidence.leavesRun &&
    siblings.summary.groups.length === 0;

  return [
    coverageRow('1.balanced', 1, 'two shards balanced from history', balanced, {
      plan: planOf(balanced),
    }),
    coverageRow('1.repeat-each', 1, '--repeat-each 2 on three shards', repeat, {
      plan: planOf(repeat),
    }),
    coverageRow('1.fully-parallel', 1, 'fullyParallel on three shards', parallel, {
      plan: planOf(parallel),
    }),
    coverageRow('1.prefix-titles', 1, 'a test and a describe block with one title', prefix),
    { ...siblingRow, status: whole ? 'pass' : 'fail' },
  ];
}

function filters(ctx) {
  const timings = ctx.baseline().history.file;
  const grep = ctx.run({
    name: 'grep',
    shards: 2,
    forward: ['--grep', 'cart|checkout'],
    timings,
  });
  const project = ctx.run({ name: 'project', shards: 2, forward: ['--project=firefox'], timings });
  return [
    coverageRow('3.grep', 3, '--grep applied to the list and to the run', grep, {
      intended: intendedCount(grep),
      plan: planOf(grep),
    }),
    coverageRow('3.project', 3, '--project=firefox applied to the list and to the run', project, {
      intended: intendedCount(project),
      plan: planOf(project),
    }),
  ];
}

// One renamed test and two new tests, each in both browser projects.
const UNHINTED_AFTER_EDIT = 6;

/** Every shard listed tests: the run had something to run with no timings file. */
function ranEverything(listed) {
  return listed.every((shard) => shard.exitCode === 0 && (shard.leaves || []).length > 0);
}

function newTests(ctx) {
  const baseline = ctx.baseline();
  const cold = ctx.run({ name: 'cold-empty-timings', shards: 2, timings: ctx.coldTimings() });
  const native = ctx.run({ name: 'cold-no-timings', shards: 2 });
  const missing = [1, 2].map((index) =>
    listShard({
      cwd: ctx.cwd,
      config: ctx.config(),
      shard: `${index}/2`,
      env: {
        PSP_FLK_TIMINGS: `${ctx.dir('cold')}/absent.json`,
        FLAKINESS_OUTPUT_DIR: ctx.reportDir('cold-missing'),
      },
    })
  );
  const coldFound = [coverageKinds(cold.summary.kinds), coverageKinds(native.summary.kinds)];

  const cwd = renamedProject(ctx);
  const renamed = ctx.run({
    name: 'renamed',
    cwd,
    shards: 2,
    timings: baseline.history.file,
    workers: 1,
    json: true,
  });
  const plan = planOf(renamed);
  if (!plan) throw new Error('the renamed project printed no balancing plan');
  const dir = ctx.dir('renamed-merge');
  const merged = buildHistory({
    dir,
    reports: flakinessReports(renamed.partition),
    existing: baseline.history.file,
  });
  const after = listShard({
    cwd,
    config: renamed.config,
    shard: '1/2',
    env: { PSP_FLK_TIMINGS: merged.file, FLAKINESS_OUTPUT_DIR: ctx.reportDir('renamed-after') },
  });
  const planAfter = parsePlan(after.output);
  if (!planAfter) throw new Error('the rebuilt history printed no balancing plan');
  const found = coverageKinds(renamed.summary.kinds);
  const unknown = plan.tests - plan.hinted;

  return [
    {
      id: '7.cold',
      proof: 7,
      title: 'no history: the full intended suite runs',
      status: coldFound.every((kinds) => Object.keys(kinds).length === 0) ? 'pass' : 'fail',
      evidence: {
        emptyTimings: { coverageViolations: coldFound[0], plan: planOf(cold) },
        noTimingsFile: {
          coverageViolations: coldFound[1],
          planPrinted: parsePlan(native.raw[0].output) !== null,
        },
      },
    },
    {
      id: '7.missing-timings-file',
      proof: 7,
      title: 'the first run: shardBalancing names a timings file that does not exist yet',
      status: ranEverything(missing) ? 'pass' : 'fail',
      evidence: {
        exits: missing.map((shard) => shard.exitCode),
        testsListedPerShard: missing.map((shard) => (shard.leaves || []).length),
        message: firstError(missing[0].output),
        failsBeforeAnyTest: classifyListing(missing, {}) === 'fails before any test',
      },
    },
    {
      id: '7.new-renamed',
      proof: 7,
      title: 'history from before a rename and a new file of two tests',
      status:
        Object.keys(found).length === 0 &&
        unknown === UNHINTED_AFTER_EDIT &&
        planAfter.hinted === planAfter.tests
          ? 'pass'
          : 'fail',
      evidence: {
        coverageViolations: found,
        plan,
        testsWithoutHint: unknown,
        testsWithoutHintAfterMerge: planAfter.tests - planAfter.hinted,
      },
    },
  ];
}

module.exports = { exactlyOnce, filters, newTests, planOf };
