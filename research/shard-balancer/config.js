'use strict';

/**
 * The Playwright config every run of the research loads. It takes the config of the project under
 * test and adds the `playwright-shard-balancer` reporter the way its README describes, with the
 * options steered by environment variables, so one generated config serves every shard of every
 * experiment:
 *
 *   PSP_PSB_TIMINGS      `timings` option (absolute path); unset leaves the package default
 *   PSP_PSB_RECORD       `record` option (absolute path, `{shard}` becomes the shard number)
 *   PSP_PSB_WORKERS      `workers` option: the workers per shard the plan packs for
 *   PSP_PSB_GRANULARITY  `granularity` option (`auto` or `file`)
 *   PSP_PSB_PLAIN        `1` leaves the reporter out (Playwright's native sharding)
 *   PSP_PSB_REPORTER     reporter file to load instead of the installed one (a modified copy)
 *   PSP_PSB_EXTRA        comma-separated Playwright reporters to add (`json`), configured through
 *                        their own environment variables
 *
 * Strict mode is the package's own `PLAYWRIGHT_SHARD_BALANCER_STRICT=1`, which the experiments set
 * in the environment of a shard like the package's restore action does.
 */

const path = require('node:path');
const { reporterPath } = require('./upstream');

/** The config of the project at `project`, with the shard-balancer reporter added. */
function configFor({ project, fullyParallel = false }) {
  const base = require(path.join(project, 'playwright.config.js'));
  const reporters = [['list']];
  for (const name of (process.env.PSP_PSB_EXTRA || '').split(',').filter(Boolean)) {
    reporters.push([name]);
  }
  if (process.env.PSP_PSB_PLAIN !== '1') {
    const options = {};
    if (process.env.PSP_PSB_TIMINGS) options.timings = process.env.PSP_PSB_TIMINGS;
    if (process.env.PSP_PSB_RECORD) options.record = process.env.PSP_PSB_RECORD;
    if (process.env.PSP_PSB_WORKERS) options.workers = Number(process.env.PSP_PSB_WORKERS);
    if (process.env.PSP_PSB_GRANULARITY) options.granularity = process.env.PSP_PSB_GRANULARITY;
    reporters.push([process.env.PSP_PSB_REPORTER || reporterPath(), options]);
  }
  return {
    ...base,
    testDir: path.resolve(project, base.testDir || '.'),
    ...(fullyParallel ? { fullyParallel: true } : {}),
    reporter: reporters,
  };
}

module.exports = { configFor };
