'use strict';

/**
 * The results the qualification is expected to reproduce, one per row, and the verdict they
 * support. `tests/proofs.test.js` compares fresh evidence with these, and
 * `tests/unit/docs.test.js` compares `docs/qualification/nsxbet.md` with them, so a change in the
 * engine, the harness or the document shows up as a failing test.
 *
 * `fail` is a reproduced failure. Only rows about the engine decide a proof or an extra case.
 */

const EXPECTED_ROWS = {
  '1.combined': 'fail',
  '1.jobs': 'pass',
  '1.merged': 'pass',
  '1.repeat-each': 'fail',
  '1.prefix-titles': 'fail',
  '1.grouped-repeat-each': 'pass',
  '2.cold': 'fail',
  '2.history': 'fail',
  '2.no-affinity': 'fail',
  '2.huge-penalty': 'fail',
  '2.grouped-cold': 'pass',
  '2.grouped-history-2': 'pass',
  '2.grouped-history-3': 'pass',
  '2.dependencies': 'pass',
  '3.grep': 'pass',
  '3.project': 'pass',
  '4.single-assignment': 'pass',
  '5.truncated': 'pass',
  '5.version': 'pass',
  '5.null-tests': 'pass',
  '5.string-durations': 'pass',
  '5.zero-durations': 'pass',
  '5.stale-ids': 'pass',
  'x1.recompute-per-shard': 'fail',
  'x1.damaged-shard-artifact': 'fail',
  '6.exit-codes': 'pass',
  '6.retries': 'pass',
  '6.artifacts': 'pass',
  '6.missing-blob': 'fail',
  '6.missing-timing-artifact': 'fail',
  '7.cold': 'pass',
  '7.new-renamed': 'pass',
  '8.damaged-history': 'fail',
  '8.failed-run': 'fail',
  '8.cancelled-run': 'fail',
  'x2.racing-publish': 'fail',
  'net.guard-control': 'pass',
  'net.plan-timing': 'pass',
  'net.mutation-control': 'pass',
  'net.os-block': 'pass',
};

const EXPECTED_PROOFS = {
  1: 'fail',
  2: 'fail',
  3: 'pass',
  4: 'pass',
  5: 'pass',
  6: 'fail',
  7: 'pass',
  8: 'fail',
};

const EXPECTED_EXTRAS = { x1: 'fail', x2: 'fail' };

/** Rows that do not decide a proof: glue code around the engine, and Playwright's own behavior. */
const ROW_SUBJECTS = {
  '1.grouped-repeat-each': 'integration',
  '2.grouped-cold': 'integration',
  '2.grouped-history-2': 'integration',
  '2.grouped-history-3': 'integration',
  '6.missing-blob': 'playwright',
};

const VERDICT = 'does not qualify';

module.exports = { EXPECTED_EXTRAS, EXPECTED_PROOFS, EXPECTED_ROWS, ROW_SUBJECTS, VERDICT };
