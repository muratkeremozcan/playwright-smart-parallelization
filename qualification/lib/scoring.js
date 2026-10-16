'use strict';

/**
 * Scoring shared by the engine qualifications. A row is `{ id, proof, title, status, evidence }`;
 * these builders turn the violations of a harness run into a row. Every row that scores a run
 * counts a leaf that skipped or never ran as a violation, so a suite that skips every test cannot
 * pass.
 */

// Violations that mean a leaf did not run exactly once to a result. A leaf that skipped or never
// ran is `not-executed`: a suite that skips every test must not pass any row.
const COVERAGE_KINDS = ['missing', 'duplicate', 'unexpected', 'not-executed'];

/** The coverage and execution violations among the violation counts of a run. */
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

module.exports = { COVERAGE_KINDS, coverageKinds, coverageRow, dependencyRow };
