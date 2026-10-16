'use strict';

/**
 * Playwright calls the qualification makes on its own, next to the harness: the leaves one shard
 * would run (a `--list` of the shard), and the plan the Flakiness reporter prints.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFromCwd } = require('../lib/playwright');

const MAX_BUFFER = 256 * 1024 * 1024;
const HARNESS_REPORTER = path.resolve(__dirname, '..', '..', 'harness', 'reporter.js');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `text` without terminal colors. */
function plain(text) {
  return text.replace(ANSI, '');
}

/** `text` with each absolute path reduced to its file name, so no evidence holds a local path. */
function scrub(text) {
  return text.replace(
    /(?:[A-Za-z]:)?(?:[\\/][^\s'"`:,;()[\]{}]+)+[\\/]([^\s'"`:,;()[\]{}\\/]+)/g,
    '$1'
  );
}

/**
 * Runs one shard of a split, or lists it, with the harness reporter added beside the config's
 * reporters, so the Flakiness reporter plans the shard exactly as it does for a normal command.
 * `list` selects `--list`: the shard's tests are listed and not run. `wrap` is a command prefix
 * (an OS-level network block). Returns `{ exitCode, leaves, output }`; `leaves` is null when the
 * run wrote none (the reporter failed before the list).
 */
function runShard({ cwd, config, shard, env = {}, args = [], list = false, wrap = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-shard-'));
  const resultFile = path.join(dir, 'result.json');
  try {
    const cli = resolveFromCwd('@playwright/test/cli', cwd);
    const command = [
      ...wrap,
      process.execPath,
      cli,
      'test',
      ...(list ? ['--list'] : []),
      `--config=${config}`,
      `--add-reporter=${HARNESS_REPORTER}`,
      ...(shard ? [`--shard=${shard}`] : []),
      ...args,
    ];
    const result = spawnSync(command[0], command.slice(1), {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...env, PSP_HARNESS_RESULT: resultFile },
    });
    const leaves = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, 'utf8')).leaves
      : null;
    return {
      exitCode: result.status === null ? 1 : result.status,
      leaves,
      output: plain(`${result.stdout || ''}${result.stderr || ''}`),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `runShard` with `--list`: what the shard would run. */
function listShard(options) {
  return runShard({ ...options, list: true });
}

/**
 * The plan lines the reporter prints before the first test, parsed: shard count, how many tests
 * the timings file knows (`hints`), the predicted work of every shard (`loads`, as printed), the
 * balance and the work of the running shard. Null when the output holds no plan.
 */
function parsePlan(output) {
  const lines = plain(output)
    .split('\n')
    .filter((line) => line.startsWith('[flakiness.io]'))
    .map((line) => line.slice('[flakiness.io]'.length).trim());
  const find = (pattern) => {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match) return match;
    }
    return null;
  };
  const shards = find(/^balancing (\d+) shards$/);
  if (!shards) return null;
  const hints = find(/^duration hints:\s+(\d+)\/(\d+) tests \((\d+)%\)/);
  const loads = find(/^shard loads:\s+(.*)$/);
  const balance = find(/^balance:\s+(\d+)%/);
  const running = find(/^(?:Running )?[Ss]hard (\d+)\/(\d+): (.*?)(?:,|$)/);
  return {
    shards: Number(shards[1]),
    hinted: hints ? Number(hints[1]) : null,
    tests: hints ? Number(hints[2]) : null,
    loads: loads ? loads[1] : null,
    balancePercent: balance ? Number(balance[1]) : null,
    runningShard: running ? { current: Number(running[1]), work: running[3] } : null,
  };
}

module.exports = { HARNESS_REPORTER, listShard, parsePlan, plain, runShard, scrub };
