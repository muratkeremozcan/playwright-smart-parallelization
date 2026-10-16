'use strict';

/**
 * The results the qualification is expected to reproduce, one per row, and the verdict they
 * support. `tests/proofs.test.js` compares fresh evidence with these, and
 * `tests/unit/docs.test.js` compares `docs/qualification/flakiness.md` with them, so a change in
 * the engine, the harness or the document shows up as a failing test.
 *
 * `fail` is a reproduced failure. Only rows about the engine decide a proof or an extra case.
 */

const { verdictFor } = require('../lib/evidence');

const EXPECTED_ROWS = {
  '1.balanced': 'pass',
  '1.repeat-each': 'pass',
  '1.fully-parallel': 'pass',
  '1.prefix-titles': 'pass',
  '1.sibling-suites': 'pass',
  '2.cold': 'pass',
  '2.history': 'pass',
  '2.history-3': 'pass',
  '2.fully-parallel': 'pass',
  '2.serial-outcomes': 'pass',
  '2.dependencies': 'pass',
  '2.setup-aware': 'pass',
  '3.grep': 'pass',
  '3.project': 'pass',
  '4.deterministic-plan': 'pass',
  '4.list-matches-run': 'pass',
  '4.applied-by-reporter': 'pass',
  '5.truncated': 'pass',
  '5.version': 'pass',
  '5.null-tests': 'pass',
  '5.string-durations': 'pass',
  '5.zero-durations': 'pass',
  '5.stale-ids': 'pass',
  '5.no-git-repository': 'pass',
  '5.mismatched-timings': 'fail',
  '5.reporter-dropped': 'fail',
  '5.reporter-overridden': 'pass',
  'x1.damaged-shard-timings': 'pass',
  '6.exit-codes': 'pass',
  '6.retries': 'pass',
  '6.artifacts': 'pass',
  '6.missing-blob': 'fail',
  '6.missing-shard-report': 'fail',
  '7.cold': 'pass',
  '7.missing-timings-file': 'fail',
  '7.new-renamed': 'pass',
  '8.damaged-history': 'pass',
  '8.failed-run': 'pass',
  '8.failed-run-slow': 'fail',
  '8.cancelled-run': 'pass',
  '8.faster-test': 'fail',
  '8.window-rebuild': 'pass',
  'x2.racing-publish': 'fail',
  'net.guard-control': 'pass',
  'net.balanced-run': 'pass',
  'net.timings-build': 'pass',
  'net.upload-control': 'pass',
  'net.mutation-control': 'pass',
  'net.os-block': 'pass',
};

const EXPECTED_PROOFS = {
  1: 'pass',
  2: 'pass',
  3: 'pass',
  4: 'pass',
  5: 'fail',
  6: 'fail',
  7: 'fail',
  8: 'fail',
};

const EXPECTED_EXTRAS = { x1: 'pass', x2: 'fail' };

/** Rows that do not decide a proof: glue code around the engine, and Playwright's own behavior. */
const ROW_SUBJECTS = {
  '6.missing-blob': 'playwright',
  '8.window-rebuild': 'integration',
};

// Derived from the proof results by the rule in `qualification/lib/evidence.js`.
const VERDICT = verdictFor(EXPECTED_PROOFS);

module.exports = { EXPECTED_EXTRAS, EXPECTED_PROOFS, EXPECTED_ROWS, ROW_SUBJECTS, VERDICT };
