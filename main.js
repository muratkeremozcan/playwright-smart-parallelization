'use strict';

/**
 * Playwright Smart Parallelization: the entry point every Node step of `action.yml` calls, as
 * `node "$GITHUB_ACTION_PATH/main.js" <step>`. Each step reads the inputs from `PSP_INPUT_*`,
 * writes its outputs, log lines and job summary, and fails with an error annotation on any
 * problem. Zero runtime dependencies: no node_modules to audit and no bundle step.
 */

const path = require('node:path');
const prepare = require('./lib/prepare');
const run = require('./lib/run');
const finish = require('./lib/finish');
const store = require('./lib/store');
const { readInputs } = require('./lib/inputs');
const { appendSummary, errorCommand, setOutputs, warningCommand } = require('./lib/util');

const PHASES = ['prepare', 'run', 'finish'];

const workspace = (env) => env.GITHUB_WORKSPACE || process.cwd();

const STEPS = {
  phase: ({ inputs }) => {
    if (!PHASES.includes(inputs.phase)) {
      throw new Error(
        `the phase input must be one of ${PHASES.join(', ')}, got ${JSON.stringify(inputs.phase)}`
      );
    }
    return {};
  },
  'prepare-key': prepare.key,
  'prepare-plan': prepare.plan,
  'run-setup': run.setup,
  'run-exec': (args) => ({ code: run.exec(args) }),
  'finish-setup': finish.setup,
  'finish-check': finish.check,
  'finish-report': finish.report,
  'store-write': ({ env }) => ({
    outputs: store.writeStep({
      dir: env.PSP_STATE_DIR,
      workspace: workspace(env),
      matchedKey: env.PSP_MATCHED_KEY || '',
    }),
  }),
  'store-clear': ({ env }) => {
    store.clearCache(workspace(env));
    return {};
  },
  'store-verify': ({ env }) => ({
    outputs: store.verifyStep({
      dir: env.PSP_STATE_DIR,
      workspace: workspace(env),
      hit: env.PSP_CACHE_HIT === 'true',
    }),
  }),
  'finish-conclude': finish.conclude,
};

async function main(step, env = process.env, write = (line) => process.stdout.write(`${line}\n`)) {
  const handler = STEPS[step];
  if (!handler) {
    write(errorCommand(`unknown step ${JSON.stringify(step)}`));
    return 1;
  }
  try {
    const result = (await handler({ inputs: readInputs(env), env })) || {};
    if (result.outputs) setOutputs(result.outputs, env);
    for (const line of result.log || []) write(`[playwright-smart-parallelization] ${line}`);
    for (const message of result.annotations || []) write(warningCommand(message));
    if (result.summary) appendSummary(result.summary, env);
    if (result.ok === false) write(errorCommand('the run failed its check; see the job summary'));
    if (typeof result.code === 'number') return result.code;
    return 0;
  } catch (error) {
    write(errorCommand(error.message));
    return 1;
  }
}

if (require.main === module) {
  main(process.argv[2]).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { STEPS, main, root: path.resolve(__dirname) };
