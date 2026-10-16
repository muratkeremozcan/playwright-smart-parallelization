/**
 * Shape B of the Action: the reporter the Action bundles and adds with `--add-reporter=<path>`.
 * The command line carries no reporter options, so this reporter takes them from the environment
 * the Action sets for each shard and hands them to playwright-shard-balancer:
 *
 *   PSP_ACTION_TIMINGS      absolute path of the timings snapshot
 *   PSP_ACTION_RECORD       absolute record path; `{shard}` becomes the shard number
 *   PSP_ACTION_WORKERS      the workers per shard the plan packs for
 *   PSP_ACTION_GRANULARITY  `auto` or `file`
 *
 * Playwright loads the user's config itself, so the config keeps its meaning.
 */

import process from 'node:process';
import ShardBalancer from 'playwright-shard-balancer';

function optionsFromEnvironment(env = process.env) {
  const options = {};
  if (env.PSP_ACTION_TIMINGS) options.timings = env.PSP_ACTION_TIMINGS;
  if (env.PSP_ACTION_RECORD) options.record = env.PSP_ACTION_RECORD;
  if (env.PSP_ACTION_WORKERS) options.workers = Number(env.PSP_ACTION_WORKERS);
  if (env.PSP_ACTION_GRANULARITY) options.granularity = env.PSP_ACTION_GRANULARITY;
  return options;
}

export default class ActionReporter extends ShardBalancer {
  constructor(options = {}) {
    super({ ...optionsFromEnvironment(), ...options });
  }
}
