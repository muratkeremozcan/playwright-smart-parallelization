'use strict';

/**
 * The run phase, once per shard. `setup` checks the plan and the shard and names the artifacts;
 * `exec` checks the installed Playwright and, when balanced, the snapshot sha, all before
 * Playwright starts, then runs the user's command with `--shard`, the workers input and one
 * `--add-reporter` that holds the user's own added reporters and the Action's reporter.
 * `disabled` adds no reporter.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HISTORY_FILE, artifactNames } = require('./identity');
const { parseCommand, shardArgv } = require('./command');
const { parsePlan, positiveInt } = require('./inputs');
const { installedPlaywrightVersion } = require('./playwright-version');
const { sha256, short } = require('./util');

const REPORTER = path.join(__dirname, '..', 'reporter', 'reporter.js');

function shardOf(inputs, plan) {
  const shard = positiveInt(inputs.shard, 'shard');
  if (shard > plan.total)
    throw new Error(`shard ${shard} is outside the plan's ${plan.total} shards`);
  return shard;
}

function paths(plan, shard, env) {
  const base = path.join(
    env.RUNNER_TEMP || os.tmpdir(),
    `psp-run-${plan.key.slice(0, 12)}-${shard}`
  );
  return {
    base,
    snapshotDir: path.join(base, 'snapshot'),
    record: path.join(base, 'record', 'record.json'),
  };
}

function setup({ inputs, env = process.env }) {
  const plan = parsePlan(inputs.plan, env);
  const shard = shardOf(inputs, plan);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
  const names = artifactNames(plan);
  const where = paths(plan, shard, env);
  fs.rmSync(where.base, { recursive: true, force: true });
  fs.mkdirSync(where.snapshotDir, { recursive: true });
  const blob = inputs['blob-report'] || 'blob-report';
  return {
    outputs: {
      mode: plan.mode,
      artifact: names.snapshot || '',
      'snapshot-dir': where.snapshotDir,
      record: plan.mode === 'disabled' ? 'false' : 'true',
      'record-name': names.record(shard, attempt),
      'record-path': where.record,
      'blob-name': names.blob(shard, attempt),
      'blob-path': path.join(env.GITHUB_WORKSPACE || process.cwd(), plan.workingDirectory, blob),
    },
    log: [`shard ${shard}/${plan.total}, mode ${plan.mode}`],
  };
}

/** The words and environment of this shard's run. Throws before anything runs on a bad input. */
function command({ inputs, env = process.env }) {
  const plan = parsePlan(inputs.plan, env);
  const shard = shardOf(inputs, plan);
  const cwd = path.join(env.GITHUB_WORKSPACE || process.cwd(), plan.workingDirectory);
  if (plan.mode === 'disabled') {
    const argv = [
      ...parseCommand(plan.command),
      `--shard=${shard}/${plan.total}`,
      ...(plan.workers ? [`--workers=${plan.workers}`] : []),
    ];
    return { argv, cwd, env: {}, plan, shard };
  }
  const installed = installedPlaywrightVersion(cwd);
  if (installed !== plan.playwright) {
    throw new Error(
      `the shard has Playwright ${installed || 'not installed'} in ${plan.workingDirectory}, the prepare ` +
        `job read ${plan.playwright} from the lockfile; install the locked dependencies before this step`
    );
  }
  const where = paths(plan, shard, env);
  const reporterEnv = {
    PSP_MODE: plan.mode,
    PSP_SHARD: String(shard),
    PSP_TOTAL: String(plan.total),
    PSP_WORKERS: String(plan.workers || 1),
    PSP_KEY: plan.key,
    PSP_RECORD: where.record,
    PSP_RUN_ID: String(plan.runId || 1),
    PSP_RUN_ATTEMPT: String(env.GITHUB_RUN_ATTEMPT || 1),
    PSP_COMMIT: plan.commit,
    PSP_RUNNER_NAME: env.RUNNER_NAME || '',
    PSP_REASON: plan.mode === 'native' ? plan.reason || '' : '',
  };
  if (plan.mode === 'balanced') {
    const file = path.join(where.snapshotDir, HISTORY_FILE);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`the snapshot artifact is missing: ${error.message}`, { cause: error });
    }
    const sha = sha256(text);
    if (sha !== plan.sha) {
      throw new Error(
        `the snapshot has sha ${short(sha)}, the prepare job pinned ${short(plan.sha)}; ` +
          'this shard stops before any test'
      );
    }
    reporterEnv.PSP_SNAPSHOT = file;
    reporterEnv.PSP_SNAPSHOT_SHA = plan.sha;
  }
  const argv = shardArgv(plan.command, {
    shard,
    total: plan.total,
    workers: plan.workers,
    reporter: REPORTER,
  });
  return { argv, cwd, env: reporterEnv, plan, shard };
}

/** Runs the shard and returns Playwright's exit code. */
function exec({ inputs, env = process.env, stdio = 'inherit' }) {
  const run = command({ inputs, env });
  process.stdout.write(`[playwright-smart-parallelization] ${run.argv.join(' ')}\n`);
  // `exec "$@"` runs the words as given, with no second round of shell expansion, and finds
  // `npx` and friends on the PATH the way the user's own step would.
  const result = spawnSync('bash', ['-c', 'exec "$@"', 'bash', ...run.argv], {
    cwd: run.cwd,
    env: { ...env, ...run.env },
    stdio,
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

module.exports = { REPORTER, command, exec, setup };
