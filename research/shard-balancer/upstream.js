'use strict';

/**
 * Thin wrapper over the installed `playwright-shard-balancer` package. The research runs the
 * published package as `research/shard-balancer/package-lock.json` installs it, with
 * `--ignore-scripts`: its reporter (the ESM file Playwright loads) and its CLI. Upstream code runs
 * only from the experiments of this directory, in temporary copies of the fixture.
 *
 * `mutatedCopy` writes a copy of the package with one property read renamed in the reporter, the
 * way a Playwright release that drops an internal field would look to it.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'playwright-shard-balancer';
const REPOSITORY = 'qa-gary-parker/playwright-shard-balancer';
const MAX_BUFFER = 256 * 1024 * 1024;
const ROOT = path.join(__dirname, 'node_modules', PACKAGE);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'consumer');
const FLAKINESS = path.join(
  REPO_ROOT,
  'qualification',
  'flakiness',
  'node_modules',
  '@flakiness',
  'playwright'
);

const INSTALL_HINT = 'run `npm run research:install` first';

/**
 * Throws a clear error, with code `PSP_NOT_INSTALLED`, when the package, the fixture or the
 * Flakiness package is not installed. The locations can be replaced, for a test.
 */
function assertInstalled({ root = ROOT, fixture = FIXTURE, flakiness = FLAKINESS } = {}) {
  const missing = [
    [path.join(root, 'package.json'), `${PACKAGE} is not installed in research/shard-balancer`],
    [
      path.join(fixture, 'node_modules', '@playwright', 'test'),
      'the consumer fixture is not installed',
    ],
    [
      path.join(flakiness, 'package.json'),
      '@flakiness/playwright is not installed in qualification/flakiness',
    ],
  ].filter(([file]) => !fs.existsSync(file));
  if (missing.length > 0) {
    const error = new Error(`${missing.map(([, why]) => why).join('; ')}: ${INSTALL_HINT}`);
    error.code = 'PSP_NOT_INSTALLED';
    throw error;
  }
}

function manifest(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

/** The resolved name and version of the installed package. */
function packageInfo() {
  const { name, version } = manifest();
  return { name, version };
}

/**
 * The commit the version was published from, as the registry records it (`gitHead`). The
 * installed manifest does not carry it, so the registry is asked.
 */
function publishedCommit(version) {
  const result = spawnSync('npm', ['view', `${PACKAGE}@${version}`, 'gitHead', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`npm view ${PACKAGE}@${version} gitHead failed: ${result.stderr}`);
  }
  const commit = JSON.parse(result.stdout);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`no gitHead for ${PACKAGE}@${version}`);
  return commit;
}

/** The reporter file Playwright loads, in the package at `root`. */
function reporterPath(root = ROOT) {
  return path.join(root, 'dist', 'reporter.js');
}

function cliPath(root = ROOT) {
  return path.join(root, 'dist', 'cli.js');
}

/**
 * Runs a CLI command. Returns `{ status, stdout, stderr, json }`: `status` is the exit code (1
 * when a signal ended it) and `json` the parsed stdout, or null when stdout is not JSON.
 */
function cli(args, { cwd = __dirname, env = {}, root = ROOT } = {}) {
  const result = spawnSync(process.execPath, [cliPath(root), ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
    json,
  };
}

/**
 * Copies the package at `from` into `dir` and replaces every `search` in `file` (relative to the
 * package) with `replace`. Returns `{ root, replacements }`; throws when nothing was replaced, so
 * an experiment never runs an unchanged copy by mistake.
 */
function mutatedCopy({ dir, from = ROOT, file = 'dist/reporter.js', search, replace }) {
  const root = path.join(dir, path.basename(from));
  fs.cpSync(from, root, { recursive: true });
  const target = path.join(root, file);
  const source = fs.readFileSync(target, 'utf8');
  const replacements = source.split(search).length - 1;
  if (replacements === 0) throw new Error(`${file} has no ${search} to replace`);
  fs.writeFileSync(target, source.split(search).join(replace));
  return { root, file: target, replacements };
}

module.exports = {
  FIXTURE,
  FLAKINESS,
  INSTALL_HINT,
  PACKAGE,
  REPOSITORY,
  REPO_ROOT,
  ROOT,
  assertInstalled,
  cli,
  cliPath,
  manifest,
  mutatedCopy,
  packageInfo,
  publishedCommit,
  reporterPath,
};
