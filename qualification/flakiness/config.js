'use strict';

/**
 * The Playwright config every Flakiness run of the qualification loads. It takes the config of
 * the project under test and adds the Flakiness reporter the way the package README describes:
 * a reporter entry with `disableUpload: true`, no token and no project binding, plus
 * `shardBalancing` pointing at a local timings file. The run is steered by environment variables,
 * so one generated config serves every shard of every check:
 *
 *   PSP_FLK_TIMINGS  path of the timings file; unset leaves Playwright's native sharding in place
 *   PSP_FLK_PLAIN    `1` leaves the Flakiness reporter out (the plain native baseline)
 *   PSP_FLK_UPLOAD   `1` leaves `disableUpload` off (the control of the network check)
 *   PSP_FLK_REPORTER  reporter file to load instead of the installed one (a modified copy)
 *   PSP_FLK_EXTRA    comma-separated Playwright reporters to run beside the Flakiness reporter
 *                    (`json`, `blob`), configured through their own environment variables
 *   FLAKINESS_OUTPUT_DIR  where the reporter writes its report (read by the package itself)
 */

const path = require('node:path');
const { reporterPath } = require('./engine');

/** The config of the project at `project`, with the Flakiness reporter added. */
function configFor({ project, fullyParallel = false }) {
  const reporter = process.env.PSP_FLK_REPORTER || reporterPath();
  const base = require(path.join(project, 'playwright.config.js'));
  const reporters = [['list']];
  for (const name of (process.env.PSP_FLK_EXTRA || '').split(',').filter(Boolean)) {
    reporters.push([name]);
  }
  if (process.env.PSP_FLK_PLAIN !== '1') {
    const options = { disableUpload: process.env.PSP_FLK_UPLOAD !== '1' };
    if (process.env.PSP_FLK_TIMINGS) {
      options.shardBalancing = { timingsFile: process.env.PSP_FLK_TIMINGS };
    }
    reporters.push([reporter, options]);
  }
  return {
    ...base,
    testDir: path.resolve(project, base.testDir || '.'),
    ...(fullyParallel ? { fullyParallel: true } : {}),
    reporter: reporters,
  };
}

module.exports = { configFor };
