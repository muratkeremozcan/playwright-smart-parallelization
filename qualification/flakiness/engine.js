'use strict';

/**
 * Thin wrapper over the installed `@flakiness/playwright` package. What is qualified is the
 * published package as installed by `qualification/flakiness/package-lock.json`: its reporter
 * (the file Playwright loads) and its `flakiness-playwright-timings` command, which builds the
 * timings file. Calls run the package's own files with the current Node binary.
 *
 * `wrap` is an optional command prefix (an OS-level network block, for example), `env` extra
 * environment variables (the network guard preload, for example) and `root` the package
 * directory to run (a modified copy, for the negative control of the network check).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = '@flakiness/playwright';
const MAX_BUFFER = 256 * 1024 * 1024;

// The package exports only its reporter, so the root is found from the reporter file.
function packageRoot() {
  return path.dirname(path.dirname(require.resolve(PACKAGE, { paths: [__dirname] })));
}

/** The resolved name and version of the engine package. */
function engineInfo() {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version };
}

/** The reporter file Playwright loads, in the package at `root`. */
function reporterPath(root = packageRoot()) {
  return path.join(root, 'lib', 'playwright-test.js');
}

/** The timings command file, in the package at `root`. */
function timingsPath(root = packageRoot()) {
  return path.join(root, 'lib', 'flakiness-playwright-timings.js');
}

/**
 * Runs the timings command. Returns `{ status, stdout, stderr, ms }`; `status` is the exit code,
 * or 1 when the process was killed by a signal.
 */
function runTimings(args, { cwd = __dirname, env = {}, wrap = [], root = packageRoot() } = {}) {
  const command = [...wrap, process.execPath, timingsPath(root), ...args];
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

/** Command line of `build`: Flakiness reports (or timings files) in, one timings file out. */
function buildArgs({ inputs, output }) {
  const args = ['build', ...inputs];
  if (output) args.push('-o', output);
  return args;
}

/** `build`: folds reports and earlier timings files into one timings file. */
function buildTimings(input, options = {}) {
  return runTimings(buildArgs(input), options);
}

module.exports = {
  PACKAGE,
  buildArgs,
  buildTimings,
  engineInfo,
  packageRoot,
  reporterPath,
  runTimings,
  timingsPath,
};
