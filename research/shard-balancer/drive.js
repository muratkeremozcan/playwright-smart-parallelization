'use strict';

/**
 * Drives `playwright-shard-balancer` against a consumer project through the S2 harness. The
 * package keeps Playwright's native `--shard=i/n`: every shard is an ordinary Playwright command
 * whose config carries the reporter, and the reporter replaces the native split with a balanced
 * one from a local timings file. A partition is therefore `n` shards of `--shard=i/n` plus the
 * environment that points each shard at its timings file and record path.
 *
 * History is built with the package's own `update` from the run records the shards write, and
 * `check` and `simulate` are called through the same CLI wrapper, which returns the exit code,
 * the JSON on stdout and stderr.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { qualify, runPartition } = require('../../harness');
const { resolveFromCwd } = require('../../qualification/lib/playwright');
const { cli } = require('./upstream');

const CONFIG_MODULE = path.resolve(__dirname, 'config.js');
const LOG_PREFIX = 'playwright-shard-balancer: ';
const MAX_BUFFER = 256 * 1024 * 1024;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Writes the config of a run into `dir` and returns its path. The file only points the shared
 * config module at the project, so the harness can load it with `--config`.
 */
function writeConfig({ dir, project, fullyParallel = false }) {
  const file = path.join(dir, 'psb.config.js');
  const source =
    `module.exports = require(${JSON.stringify(CONFIG_MODULE)}).configFor(` +
    `${JSON.stringify({ project, fullyParallel })});\n`;
  fs.writeFileSync(file, source);
  return file;
}

/** The record path every shard of a run writes to; the reporter replaces `{shard}`. */
function recordPattern(dir) {
  return path.join(dir, 'records', 'run-{shard}.json');
}

/**
 * The environment of one shard. `timings` sets the timings option, `record` the record path of
 * the run in `dir`, `workers` and `granularity` the plan options, `plain` leaves the reporter out,
 * `reporter` loads another reporter file and `json` adds Playwright's JSON reporter. `env` is
 * added last.
 */
function shardEnv({
  dir,
  index,
  timings,
  record = true,
  workers,
  granularity,
  plain,
  reporter,
  json,
  env = {},
}) {
  return {
    ...(timings ? { PSP_PSB_TIMINGS: timings } : {}),
    ...(record && !plain ? { PSP_PSB_RECORD: recordPattern(dir) } : {}),
    ...(workers ? { PSP_PSB_WORKERS: String(workers) } : {}),
    ...(granularity ? { PSP_PSB_GRANULARITY: granularity } : {}),
    ...(plain ? { PSP_PSB_PLAIN: '1' } : {}),
    ...(reporter ? { PSP_PSB_REPORTER: reporter } : {}),
    ...(json
      ? {
          PSP_PSB_EXTRA: 'json',
          PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(dir, `report-${index}.json`),
        }
      : {}),
    ...env,
  };
}

/**
 * The shards `--shard=1/n` to `--shard=n/n`. `shard(index)` may return `{ args, env }` that is
 * added to that shard only, for experiments that give one shard another input.
 */
function partitionOf({ shards, dir, shard = () => ({}), ...options }) {
  return Array.from({ length: shards }, (_, position) => {
    const index = position + 1;
    const own = shard(index) || {};
    return {
      args: [`--shard=${index}/${shards}`, ...(own.args || [])],
      env: { ...shardEnv({ dir, index, ...options }), ...(own.env || {}) },
    };
  });
}

/** Violation counts by kind. */
function violationKinds(report) {
  const counts = {};
  for (const violation of report.violations) {
    counts[violation.kind] = (counts[violation.kind] || 0) + 1;
  }
  return counts;
}

/**
 * Runs the harness over a partition. Returns the report, the violation counts and `raw`, the
 * per-shard results (exit code, leaves with outcomes, output) the report is built from.
 */
function execute({ cwd, config, partition, listing, repeatEach = 1, workers = 1, forward = [] }) {
  let raw = null;
  const report = qualify(
    { cwd, config, partition, listing, repeatEach, workers, forward },
    {
      quiet: true,
      deps: {
        runPartition: (options, shards) => {
          raw = runPartition(options, shards);
          return raw;
        },
      },
    }
  );
  return { report, kinds: violationKinds(report), raw };
}

/** The record each shard of a partition wrote, in shard order; null for a shard that wrote none. */
function records(partition) {
  return partition.map((shard, position) => {
    const pattern = shard.env && shard.env.PSP_PSB_RECORD;
    if (!pattern) return null;
    // An unsharded run writes its record under `all`.
    const file = [String(position + 1), 'all']
      .map((name) => pattern.replaceAll('{shard}', name))
      .find((candidate) => fs.existsSync(candidate));
    return file ? { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) } : null;
  });
}

/** `text` without terminal colors. */
function plain(text) {
  return text.replace(ANSI, '');
}

/** The lines the package logged in `output`, without its prefix. */
function logLines(output) {
  return plain(output || '')
    .split('\n')
    .filter((line) => line.startsWith(LOG_PREFIX))
    .map((line) => line.slice(LOG_PREFIX.length));
}

/**
 * The plan line a balanced shard logs, parsed: shard, files, tests, the timings and plan shas, the
 * known and total tests, the plan workers and the notes appended after the plan sha. Null when
 * `line` is no plan line.
 */
function parsePlanLine(line) {
  const match =
    /^shard (\d+)\/(\d+): (\d+) files, (\d+) tests, ~(\S+) \(all shards (\S+)-(\S+), largest group (\S+)\), timings (\w+), (\d+)\/(\d+) tests known, (\d+) worker\(s\), plan (\w+)(.*)$/.exec(
      line
    );
  if (!match) return null;
  return {
    shard: Number(match[1]),
    total: Number(match[2]),
    files: Number(match[3]),
    tests: Number(match[4]),
    predicted: match[5],
    range: [match[6], match[7]],
    largestGroup: match[8],
    timingsSha: match[9],
    known: Number(match[10]),
    listed: Number(match[11]),
    workers: Number(match[12]),
    planSha: match[13],
    notes: match[14]
      .split(', ')
      .map((note) => note.trim())
      .filter(Boolean),
  };
}

/** The plan line of every shard of a run, parsed, in shard order (null for a shard without one). */
function planLines(raw) {
  return raw.map((shard) => {
    const lines = logLines(shard.output).map(parsePlanLine).filter(Boolean);
    return lines[0] || null;
  });
}

/** The keys of the primary leaves each shard ran, in shard order. */
function leafSets(run) {
  const dependency = new Set(run.listing.leaves.filter((l) => l.dependency).map((l) => l.key));
  return run.raw.map((shard) =>
    (shard.leaves || [])
      .map((leaf) => leaf.key)
      .filter((key) => !dependency.has(key))
      .sort()
  );
}

/** Whether two runs gave every shard the same primary leaves. */
function sameSplit(a, b) {
  return JSON.stringify(leafSets(a)) === JSON.stringify(leafSets(b));
}

/**
 * Runs Playwright once outside the harness, for a list or a single command. `args` follow
 * `playwright test`. Returns `{ exitCode, output }`.
 */
function playwright({ cwd, args, env = {} }) {
  const cliFile = resolveFromCwd('@playwright/test/cli', cwd);
  const result = spawnSync(process.execPath, [cliFile, 'test', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status === null ? 1 : result.status,
    output: plain(`${result.stdout || ''}${result.stderr || ''}`),
  };
}

/** Writes the JSON `--list` report the package's `simulate` and `plan` read. Returns its path. */
function listReport({ cwd, config, file, forward = [] }) {
  const listed = playwright({
    cwd,
    args: ['--list', '--reporter=json', `--config=${config}`, ...forward],
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: file, PSP_PSB_PLAIN: '1' },
  });
  if (listed.exitCode !== 0 || !fs.existsSync(file)) {
    throw new Error(`playwright test --list failed: ${listed.output.slice(0, 400)}`);
  }
  return file;
}

/** `update --timings FILE INPUT...`. */
function update(timings, inputs, options = {}) {
  return cli(['update', '--timings', timings, ...inputs], options);
}

/** `check RECORD... [--list FILE] [--summary FILE]`. */
function check(files, { list, summary, ...options } = {}) {
  return cli(
    [
      'check',
      ...files,
      ...(list ? ['--list', list] : []),
      ...(summary ? ['--summary', summary] : []),
    ],
    options
  );
}

/** `simulate` with the given flags (`{ timings, list, shards, workers, granularity, overhead }`). */
function simulate({ timings, list, shards, workers, granularity, overhead }, options = {}) {
  return cli(
    [
      'simulate',
      ...['--timings', timings, '--list', list, '--shards', String(shards)],
      ...(workers ? ['--workers', String(workers)] : []),
      ...(granularity ? ['--granularity', granularity] : []),
      ...(overhead ? ['--overhead', overhead] : []),
    ],
    options
  );
}

/** The entries of a timings file. */
function readTimings(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The samples of one key in a timings file, or null. */
function samplesOf(file, key) {
  const entry = readTimings(file).tests[key];
  return entry ? entry.samples : null;
}

module.exports = {
  LOG_PREFIX,
  check,
  execute,
  leafSets,
  listReport,
  logLines,
  parsePlanLine,
  partitionOf,
  planLines,
  plain,
  playwright,
  readTimings,
  recordPattern,
  records,
  sameSplit,
  samplesOf,
  shardEnv,
  simulate,
  update,
  violationKinds,
  writeConfig,
};
