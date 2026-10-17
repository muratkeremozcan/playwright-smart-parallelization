'use strict';

/**
 * The Action's inputs. The runner passes each one to the Node process as `INPUT_<NAME>` (upper
 * case, dashes kept), the way `@actions/core` reads them. `actionInputs` validates the inputs of
 * the shard step and derives the history key from them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { historyKey } = require('./identity');

const envName = (input) => `INPUT_${input.replace(/ /g, '_').toUpperCase()}`;

/** The trimmed value of every input in `names`, empty when unset. */
function readInputs(names, env = process.env) {
  return Object.fromEntries(names.map((name) => [name, String(env[envName(name)] || '').trim()]));
}

const ACTION_INPUTS = [
  'enabled',
  'workers',
  'working-directory',
  'runner-label',
  'history-key',
  'publish-history',
];
const FINISH_INPUTS = ['history-key', 'github-token'];

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

/** The inputs of the shard step, validated, with the history key. */
function actionInputs(inputs, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const workers = inputs.workers ? positiveInt(inputs.workers, 'workers', 1024) : null;
  const enabled = booleanInput(inputs.enabled || 'true', 'enabled');
  const publish = publishInput(inputs['publish-history']);
  const wd = workingDirectory(inputs['working-directory'], workspace);
  if (!fs.existsSync(path.join(workspace, wd))) {
    throw new Error(`the working-directory ${wd} does not exist in the workspace`);
  }
  const runnerLabel =
    inputs['runner-label'] || `${env.RUNNER_OS || 'unknown'}-${env.RUNNER_ARCH || 'unknown'}`;
  const extra = inputs['history-key'] || '';
  return {
    workspace,
    workers,
    enabled,
    publish,
    workingDirectory: wd,
    runnerLabel,
    historyKey: extra,
    key: historyKey({ workingDirectory: wd, workers, runnerLabel, historyKey: extra }),
  };
}

module.exports = {
  ACTION_INPUTS,
  FINISH_INPUTS,
  actionInputs,
  booleanInput,
  envName,
  positiveInt,
  publishInput,
  readInputs,
  workingDirectory,
};
