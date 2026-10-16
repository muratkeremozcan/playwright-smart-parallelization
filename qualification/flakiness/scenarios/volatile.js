'use strict';

/**
 * The volatile test shared by the history and report checks: a passing variant whose durations
 * are the history of the failing variant. The durations stay unrounded, and the firefox project
 * takes a fixed extra time, so the two projects always keep their own entry: `build` stores one
 * entry for equal durations, which row `8.equal-durations` covers on its own. The other rows
 * measure the longest-duration rule on history that keeps each project apart.
 */

const { greenProject } = require('../../lib/variants');
const { testDurations } = require('../drive');

const FIREFOX_EXTRA_MS = 100;
const PROJECTS = ['chromium', 'firefox'];
// The volatile test, as `testDurations` keys it.
const VOLATILE = 'volatile.spec.js › volatile step';

/** The passing variant run natively, with the reporter, and the history built from its reports. */
function greenBaseline(ctx) {
  const green = ctx.baseline({
    name: 'volatile-green',
    cwd: greenProject(ctx),
    roundMs: 0,
    env: { PSP_VOLATILE_FIREFOX_EXTRA_MS: String(FIREFOX_EXTRA_MS) },
  });
  const perProject = testDurations(green.history.file, { byEnvironment: true });
  const [chromium, firefox] = PROJECTS.map((project) => perProject.get(`${project} › ${VOLATILE}`));
  if (chromium === undefined || firefox === undefined || chromium === firefox) {
    throw new Error(`the history lacks a separate entry per project (${chromium}, ${firefox})`);
  }
  return green;
}

module.exports = { FIREFOX_EXTRA_MS, PROJECTS, VOLATILE, greenBaseline };
