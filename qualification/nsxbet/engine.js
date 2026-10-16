'use strict';

/**
 * Thin wrapper over the installed `@nsxbet/playwright-orchestrator` command line. Every call runs
 * the package's own `bin/run.js` with the current Node binary, so what is qualified is the
 * published package as installed by `qualification/nsxbet/package-lock.json`.
 *
 * `wrap` is an optional command prefix (an OS-level network block, for example), `env` extra
 * environment variables (the network guard preload, for example) and `root` the package
 * directory to run (a modified copy, for the negative control of the network check).
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PACKAGE = '@nsxbet/playwright-orchestrator';
const MAX_BUFFER = 256 * 1024 * 1024;

function packageRoot() {
  return path.dirname(require.resolve(`${PACKAGE}/package.json`, { paths: [__dirname] }));
}

/** The resolved name and version of the engine package. */
function engineInfo() {
  const manifest = require(`${PACKAGE}/package.json`);
  return { name: manifest.name, version: manifest.version };
}

/**
 * Runs one engine command. Returns `{ status, stdout, stderr, ms }`; `status` is the exit code,
 * or 1 when the process was killed by a signal.
 */
function runEngine(args, { cwd = __dirname, env = {}, wrap = [], root = packageRoot() } = {}) {
  const command = [...wrap, process.execPath, path.join(root, 'bin', 'run.js'), ...args];
  const started = process.hrtime.bigint();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
    ms,
  };
}

/** The last JSON object printed on a line of `stdout`, or null. */
function lastJsonLine(stdout) {
  const lines = stdout.split('\n').filter((line) => line.startsWith('{'));
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

/** Command line of `assign`. */
function assignArgs({
  testList,
  shards,
  timingFile,
  project,
  fileAffinity = true,
  penalty,
  timeout,
  verbose = false,
}) {
  const args = ['assign', '--test-list', testList, '--shards', String(shards)];
  if (timingFile) args.push('--timing-file', timingFile);
  if (project) args.push('--project', project);
  if (!fileAffinity) args.push('--no-file-affinity');
  if (penalty !== undefined) args.push('--file-affinity-penalty', String(penalty));
  if (timeout !== undefined) args.push('--timeout', String(timeout));
  if (verbose) args.push('--verbose');
  return args;
}

/** Command line of `extract-timing`. */
function extractArgs({ reportFile, outputFile, project, shard = 1 }) {
  const args = ['extract-timing', '--report-file', reportFile, '--project', project];
  args.push('--shard', String(shard));
  if (outputFile) args.push('--output-file', outputFile);
  return args;
}

/** Command line of `merge-timing`. */
function mergeArgs({ existing, artifacts, output, pruneDays, currentTests }) {
  const args = ['merge-timing', '--new', ...artifacts, '--output', output];
  if (existing) args.push('--existing', existing);
  if (pruneDays !== undefined) args.push('--prune-days', String(pruneDays));
  if (currentTests) args.push('--current-tests', currentTests);
  return args;
}

/**
 * `assign`: the per-shard assignment for a Playwright list JSON. Returns the run result plus
 * `assignment`, the parsed JSON output (null when the command printed none).
 */
function assign(input, options = {}) {
  const result = runEngine(assignArgs(input), options);
  return { ...result, assignment: lastJsonLine(result.stdout) };
}

/** `extract-timing`: one timing artifact from a Playwright JSON report. */
function extractTiming(input, options = {}) {
  return runEngine(extractArgs(input), options);
}

/** `merge-timing`: folds timing artifacts into a history file with the engine's moving average. */
function mergeTiming(input, options = {}) {
  const result = runEngine(mergeArgs(input), options);
  return { ...result, summary: lastJsonLine(result.stdout) };
}

module.exports = {
  PACKAGE,
  assign,
  assignArgs,
  engineInfo,
  extractArgs,
  extractTiming,
  lastJsonLine,
  mergeArgs,
  mergeTiming,
  packageRoot,
  runEngine,
};
