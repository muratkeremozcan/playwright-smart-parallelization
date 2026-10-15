'use strict';

/**
 * Proofs 1, 3 and 7: exactly-once coverage, filters and project selection, no history and new or
 * renamed tests. Each function takes the shared context and returns proof rows.
 */

const COVERAGE_KINDS = ['missing', 'duplicate', 'unexpected'];

function coverageKinds(kinds) {
  return Object.fromEntries(COVERAGE_KINDS.filter((kind) => kinds[kind]).map((k) => [k, kinds[k]]));
}

function coverageRow(id, proof, title, run, extra = {}) {
  const found = coverageKinds(run.summary.kinds);
  return {
    id,
    proof,
    title,
    status: Object.keys(found).length === 0 ? 'pass' : 'fail',
    evidence: { coverageViolations: found, kinds: run.summary.kinds, ...extra },
  };
}

function exactlyOnce(ctx) {
  const combined = ctx.engineRun({ name: 'combined-cold', flow: 'combined', shards: 2 });
  const jobs = ctx.engineRun({ name: 'jobs-cold', flow: 'jobs', shards: 2 });
  const merged = ctx.engineRun({ name: 'merged-cold', flow: 'merged', shards: 2 });
  const repeat = ctx.engineRun({ name: 'merged-repeat', flow: 'merged', shards: 3, repeatEach: 2 });
  const grouped = ctx.engineRun({
    name: 'grouped-repeat',
    flow: 'grouped',
    shards: 3,
    repeatEach: 2,
  });
  return [
    coverageRow(
      '1.combined',
      1,
      'one list for the whole config, as the Quick Start does',
      combined
    ),
    coverageRow('1.jobs', 1, 'one assignment and set of jobs per project', jobs, {
      jobs: jobs.partition.length,
    }),
    coverageRow('1.merged', 1, 'one assignment per project merged into one list per shard', merged),
    coverageRow('1.repeat-each', 1, '--repeat-each 2 on three shards', repeat),
    {
      ...coverageRow(
        '1.grouped-repeat-each',
        1,
        '--repeat-each 2 on three shards, through the shim',
        grouped
      ),
      subject: 'integration',
    },
  ];
}

function filters(ctx) {
  const baseline = ctx.baseline();
  const grep = ctx.engineRun({
    name: 'merged-grep',
    flow: 'merged',
    shards: 2,
    forward: ['--grep', 'cart|checkout'],
    timing: baseline.history.timing,
  });
  const project = ctx.engineRun({
    name: 'merged-project',
    flow: 'merged',
    shards: 2,
    forward: ['--project=firefox'],
    timing: baseline.history.timing,
  });
  return [
    coverageRow('3.grep', 3, '--grep applied to the list and to the run', grep, {
      intended: grep.listing.leaves.filter((leaf) => !leaf.dependency).length,
    }),
    coverageRow('3.project', 3, '--project=firefox applied to the list and to the run', project, {
      intended: project.listing.leaves.filter((leaf) => !leaf.dependency).length,
    }),
  ];
}

module.exports = { coverageKinds, coverageRow, exactlyOnce, filters };
