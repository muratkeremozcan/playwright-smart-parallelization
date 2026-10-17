'use strict';

/**
 * The run phase, once per shard. `setup` checks the plan and the shard and names the artifacts;
 * `exec` checks the installed Playwright and, when balanced, the snapshot sha, all before
 * Playwright starts, then runs the user's command with `--shard`, the workers input and one
 * `--add-reporter` that holds the user's own added reporters, `blob` and the Action's reporter,
 * with every blob report written to a file in a folder the Action owns. `disabled` runs the plain
 * command with `--shard` and `--workers` and adds no reporter, so Playwright below 1.63, which has
 * no `--add-reporter`, still runs. It sets the same blob variables, so a blob reporter of the
 * user's config writes into the Action's folder and is uploaded (`defaultBlobDir` covers a
 * Playwright that ignores them), and it writes a status record (shard, attempt, exit code), so
 * finish still fails when a shard failed or never ran.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HISTORY_FILE, artifactNames } = require('./identity');
const { parseCommand, shardArgv } = require('./command');
const { parsePlan, positiveInt } = require('./inputs');
const { installedPlaywrightVersion } = require('./playwright-version');
const { STATUS_SCHEMA, RECORD_VERSION } = require('./check');
const { sha256, short, writeAtomic } = require('./util');

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
    blob: path.join(base, 'blob-report'),
  };
}

/**
 * Where every blob reporter of a shard writes: one file in the Action's folder. The file name
 * beats any `PLAYWRIGHT_BLOB_OUTPUT_FILE` the job inherits, and any `outputDir` or `outputFile` of
 * a blob reporter the user's config sets. That reporter and the Action's then write the same file;
 * Playwright 1.64.1 awaits each reporter's `onEnd` in turn (`Multiplexer.onEnd`,
 * playwright/lib/runner/index.js:1645) and the blob reporter writes its zip in `onEnd` (:3117), so
 * the second write replaces the first whole.
 */
const blobOutput = (dir, shard) => ({
  PLAYWRIGHT_BLOB_OUTPUT_DIR: dir,
  PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(dir, `report-${shard}.zip`),
});

/**
 * Where a blob reporter writes when nothing sets its output: Playwright's default `blob-report` in
 * the folder of the nearest `package.json` at or above the config's folder, else the process's
 * working directory (`resolveReporterOutputPath`, playwright/lib/util.js:215). The config is the
 * one the command names (`--config` or `-c`, a file or a folder), else the working directory.
 * Disabled mode copies from here only when the Playwright of the run ignored the blob variables.
 */
function defaultBlobDir(command, cwd) {
  const words = parseCommand(command);
  let config = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--config' || word === '-c') config = words[i + 1] || null;
    else if (word.startsWith('--config=')) config = word.slice('--config='.length);
    else if (/^-c./.test(word)) config = word.slice(2);
  }
  let configDir = cwd;
  if (config) {
    const resolved = path.resolve(cwd, config);
    const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    configDir = isDir ? resolved : path.dirname(resolved);
  }
  for (let dir = configDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'blob-report');
    if (path.dirname(dir) === dir) return path.join(cwd, 'blob-report');
  }
}

function setup({ inputs, env = process.env }) {
  const plan = parsePlan(inputs.plan, env);
  const shard = shardOf(inputs, plan);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
  const names = artifactNames(plan);
  const where = paths(plan, shard, env);
  fs.rmSync(where.base, { recursive: true, force: true });
  fs.mkdirSync(where.snapshotDir, { recursive: true });
  return {
    outputs: {
      mode: plan.mode,
      artifact: names.snapshot || '',
      'snapshot-dir': where.snapshotDir,
      record: 'true',
      'record-name': names.record(shard, attempt),
      'record-path': where.record,
      'blob-name': names.blob(shard, attempt),
      'blob-path': where.blob,
    },
    log: [`shard ${shard}/${plan.total}, mode ${plan.mode}`],
  };
}

/** The words and environment of this shard's run. Throws before anything runs on a bad input. */
function command({ inputs, env = process.env }) {
  const plan = parsePlan(inputs.plan, env);
  const shard = shardOf(inputs, plan);
  const cwd = path.join(env.GITHUB_WORKSPACE || process.cwd(), plan.workingDirectory);
  const blobEnv = blobOutput(paths(plan, shard, env).blob, shard);
  if (plan.mode === 'disabled') {
    const argv = [
      ...parseCommand(plan.command),
      `--shard=${shard}/${plan.total}`,
      ...(plan.workers ? [`--workers=${plan.workers}`] : []),
    ];
    // No reporter: only the blob variables, which point a blob reporter of the user's config at
    // the Action's folder over any output its config or the job sets.
    return { argv, cwd, env: blobEnv, plan, shard };
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
    ...blobEnv,
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
  // The Action's own inputs stay out of the user's test process.
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('PSP_INPUT'))
  );
  const result = spawnSync('bash', ['-c', 'exec "$@"', 'bash', ...run.argv], {
    cwd: run.cwd,
    env: { ...inherited, ...run.env },
    stdio,
  });
  if (result.error) throw result.error;
  const code = result.status === null ? 1 : result.status;
  if (run.plan.mode === 'disabled') {
    const blobDir = paths(run.plan, run.shard, env).blob;
    const empty = !fs.existsSync(blobDir) || fs.readdirSync(blobDir).length === 0;
    const fallback = defaultBlobDir(run.plan.command, run.cwd);
    if (empty && fs.existsSync(fallback)) {
      for (const name of fs.readdirSync(fallback).filter((n) => n.endsWith('.zip'))) {
        fs.mkdirSync(blobDir, { recursive: true });
        fs.copyFileSync(path.join(fallback, name), path.join(blobDir, name));
      }
    }
    const status = {
      schema: STATUS_SCHEMA,
      version: RECORD_VERSION,
      run: { id: run.plan.runId, attempt: Number(env.GITHUB_RUN_ATTEMPT || 1) },
      shard: { current: run.shard, total: run.plan.total },
      exitCode: code,
    };
    writeAtomic(paths(run.plan, run.shard, env).record, `${JSON.stringify(status)}\n`);
  }
  return code;
}

module.exports = { REPORTER, blobOutput, command, defaultBlobDir, exec, setup };
