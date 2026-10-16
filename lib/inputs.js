'use strict';

/**
 * The Action's inputs and its plan. `action.yml` passes every input to every Node step as
 * `PSP_INPUT_<NAME>` (upper case, dashes as underscores). The plan is the JSON the prepare phase
 * outputs and the run and finish phases take back; each phase that reads it checks that it belongs
 * to this run and that its key and fingerprint follow from its own fields, so a plan from another
 * run or a hand-edited one is refused.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, historyKey } = require('./identity');
const { parseCommand, assertSupported } = require('./command');

const INPUTS = [
  'phase',
  'shards',
  'command',
  'working-directory',
  'workers',
  'runner-label',
  'history-key',
  'enabled',
  'publish-history',
  'plan',
  'shard',
  'blob-report',
  'github-token',
];

const envName = (input) => `PSP_INPUT_${input.toUpperCase().replace(/-/g, '_')}`;

function readInputs(env = process.env) {
  const inputs = {};
  for (const name of INPUTS) inputs[name] = (env[envName(name)] || '').trim();
  return inputs;
}

function positiveInt(value, name, max = Infinity) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) {
    throw new Error(
      `the ${name} input must be a whole number from 1 to ${max}, got ${JSON.stringify(value)}`
    );
  }
  return Number(value);
}

/** `publish-history`: `auto` (the default branch only), `true` or `false`. */
function publishInput(value) {
  const mode = value || 'auto';
  if (!['auto', 'true', 'false'].includes(mode)) {
    throw new Error(
      `the publish-history input must be auto, true or false, got ${JSON.stringify(value)}`
    );
  }
  return mode;
}

function booleanInput(value, name) {
  if (value !== 'true' && value !== 'false') {
    throw new Error(`the ${name} input must be true or false, got ${JSON.stringify(value)}`);
  }
  return value === 'true';
}

/** The working directory relative to the workspace, in POSIX form, refusing a path outside it. */
function workingDirectory(value, workspace) {
  const absolute = path.resolve(workspace, value || '.');
  const relative = path.relative(path.resolve(workspace), absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`the working-directory ${value} is outside the workspace`);
  }
  return relative.split(path.sep).join('/') || '.';
}

/** The inputs of the prepare phase, validated, with the history key. */
function prepareInputs(inputs, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const total = positiveInt(inputs.shards, 'shards', 256);
  const workers = inputs.workers ? positiveInt(inputs.workers, 'workers', 1024) : null;
  const enabled = booleanInput(inputs.enabled || 'true', 'enabled');
  const argv = parseCommand(inputs.command);
  assertSupported(argv);
  const wd = workingDirectory(inputs['working-directory'], workspace);
  if (!fs.existsSync(path.join(workspace, wd))) {
    throw new Error(`the working-directory ${wd} does not exist in the workspace`);
  }
  const runnerLabel =
    inputs['runner-label'] || `${env.RUNNER_OS || 'unknown'}-${env.RUNNER_ARCH || 'unknown'}`;
  const key = historyKey({
    argv,
    workingDirectory: wd,
    workers,
    runnerLabel,
    historyKey: inputs['history-key'],
  });
  return {
    workspace,
    total,
    workers,
    enabled,
    command: inputs.command,
    argv,
    workingDirectory: wd,
    runnerLabel,
    historyKey: inputs['history-key'],
    key,
  };
}

const MODES = ['balanced', 'native', 'disabled'];

/**
 * Parses and checks a plan. It must be of this run and commit, and its key and fingerprint must
 * follow from its fields.
 */
function parsePlan(text, env = process.env) {
  if (!text) throw new Error('the plan input is empty: pass needs.<prepare job>.outputs.plan');
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw new Error(`the plan input is not JSON: ${error.message}`, { cause: error });
  }
  const fieldsOk =
    plan &&
    plan.v === 1 &&
    MODES.includes(plan.mode) &&
    Number.isSafeInteger(plan.total) &&
    plan.total >= 1 &&
    typeof plan.key === 'string' &&
    typeof plan.command === 'string' &&
    typeof plan.workingDirectory === 'string' &&
    (plan.workers === null || (Number.isSafeInteger(plan.workers) && plan.workers >= 1)) &&
    typeof plan.runnerLabel === 'string' &&
    typeof plan.historyKey === 'string' &&
    Number.isSafeInteger(plan.runId) &&
    Number.isSafeInteger(plan.attempt) &&
    plan.attempt >= 1 &&
    ((plan.epoch === null && plan.seq === null) ||
      (Number.isSafeInteger(plan.epoch) &&
        plan.epoch >= 1 &&
        Number.isSafeInteger(plan.seq) &&
        plan.seq >= 1)) &&
    typeof plan.commit === 'string' &&
    (plan.mode !== 'balanced' || /^[0-9a-f]{64}$/.test(plan.sha || ''));
  if (!fieldsOk) throw new Error('the plan input is not a plan of this Action');
  if (env.GITHUB_RUN_ID && String(plan.runId) !== String(env.GITHUB_RUN_ID)) {
    throw new Error(`the plan was made by run ${plan.runId}, not this run (${env.GITHUB_RUN_ID})`);
  }
  if (env.GITHUB_SHA && plan.commit !== env.GITHUB_SHA) {
    throw new Error(`the plan was made for commit ${plan.commit}, this job runs ${env.GITHUB_SHA}`);
  }
  const argv = parseCommand(plan.command);
  assertSupported(argv);
  const key = historyKey({
    argv,
    workingDirectory: plan.workingDirectory,
    workers: plan.workers,
    runnerLabel: plan.runnerLabel,
    historyKey: plan.historyKey,
  });
  if (key !== plan.key) throw new Error('the plan key does not match its command and inputs');
  if (plan.mode !== 'disabled' && plan.fingerprint !== fingerprint(plan.key, plan.playwright)) {
    throw new Error('the plan fingerprint does not match its key and Playwright version');
  }
  return plan;
}

module.exports = {
  INPUTS,
  booleanInput,
  envName,
  publishInput,
  parsePlan,
  positiveInt,
  prepareInputs,
  readInputs,
  workingDirectory,
};
