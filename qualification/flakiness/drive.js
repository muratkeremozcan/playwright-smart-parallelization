'use strict';

/**
 * Drives the Flakiness reporter against a consumer project through the S2 harness. The engine
 * keeps Playwright's native `--shard=i/n`: every shard is an ordinary Playwright command whose
 * config carries the reporter, and the reporter replaces the native split with a balanced one
 * from a local timings file. A partition is therefore `n` shards of `--shard=i/n` plus the
 * environment that points each shard at its timings file and report folder.
 *
 * Timing history is built from the Flakiness reports the shards write: `build` over the report
 * of every shard, and over the previous timings file to keep earlier observations.
 */

const fs = require('node:fs');
const path = require('node:path');
const { qualify, runPartition } = require('../../harness');
const { tempDir: makeTempDir } = require('../lib/project');
const { buildTimings } = require('./engine');

const CONFIG_MODULE = path.resolve(__dirname, 'config.js');

const tempDir = (prefix) => makeTempDir(`flk-${prefix}`);

/**
 * Writes the config of a run into `dir` and returns its path. The file only points the shared
 * config module at the project, so the harness can load it with `--config`.
 */
function writeConfig({ dir, project, fullyParallel = false }) {
  const file = path.join(dir, 'flakiness.config.js');
  const source =
    `module.exports = require(${JSON.stringify(CONFIG_MODULE)}).configFor(` +
    `${JSON.stringify({ project, fullyParallel })});\n`;
  fs.writeFileSync(file, source);
  return file;
}

/**
 * The environment of shard `index` (1 based). `timings` points the reporter at a timings file,
 * `plain` leaves the reporter out, `upload` leaves its upload on, `json` and `blob` add Playwright's
 * own reporters, each writing under `dir`. `env` is added last.
 */
function shardEnv({ dir, index, timings, plain, upload, json, blob, env = {} }) {
  const extra = [json ? 'json' : null, blob ? 'blob' : null].filter(Boolean);
  return {
    FLAKINESS_OUTPUT_DIR: path.join(dir, `flakiness-${index}`),
    ...(timings ? { PSP_FLK_TIMINGS: timings } : {}),
    ...(plain ? { PSP_FLK_PLAIN: '1' } : {}),
    ...(upload ? { PSP_FLK_UPLOAD: '1' } : {}),
    ...(extra.length > 0 ? { PSP_FLK_EXTRA: extra.join(',') } : {}),
    ...(json ? { PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(dir, `report-${index}.json`) } : {}),
    ...(blob ? { PLAYWRIGHT_BLOB_OUTPUT_DIR: path.join(dir, `blob-${index}`) } : {}),
    ...env,
  };
}

/**
 * The shards `--shard=1/n` to `--shard=n/n`. `timings` is a timings file (balanced sharding) or
 * absent (the reporter leaves Playwright's native split in place). `output` gives each shard its
 * own Playwright output directory, so traces and attachments of one shard stay apart.
 */
function partitionOf({ shards, dir, output = false, ...options }) {
  return Array.from({ length: shards }, (_, position) => {
    const index = position + 1;
    return {
      args: [
        `--shard=${index}/${shards}`,
        ...(output ? [`--output=${path.join(dir, `results-${index}`)}`] : []),
      ],
      env: shardEnv({ dir, index, ...options }),
    };
  });
}

/** Paths of the Flakiness `report.json` files the shards of `partition` wrote. */
function flakinessReports(partition) {
  return partition
    .map((shard) => path.join(shard.env.FLAKINESS_OUTPUT_DIR, 'report.json'))
    .filter((file) => fs.existsSync(file));
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

/**
 * Writes a copy of a report or timings file with every attempt duration passed through `change`.
 * Returns the path of the copy (`output`, or `file` itself when none is given).
 */
function mapDurations(file, change, output = file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const visit = (suite) => {
    for (const test of suite.tests || []) {
      for (const attempt of test.attempts || []) attempt.duration = change(attempt.duration);
    }
    (suite.suites || []).forEach(visit);
  };
  visit({ tests: report.tests, suites: report.suites });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  return output;
}

/** Rounds every attempt duration of a timings file to a multiple of `step` ms. */
function roundDurations(file, step) {
  return mapDurations(file, (duration) => Math.round(duration / step) * step);
}

/** A copy of a report whose durations are `factor` times as long. */
function scaleDurations(file, factor, output) {
  return mapDurations(file, (duration) => Math.round(duration * factor), output);
}

/**
 * The duration of every test in a report or timings file: the attempts of a run summed per
 * environment (the project), keyed by `file › titles › test`, and the longest environment taken,
 * as the reporter prices a test. A timings file written by `build` stores one attempt for a test
 * whose environments took equally long, so only the longest is reliable there. With
 * `byEnvironment` the key starts with the environment, which is exact for a report a shard wrote.
 */
function testDurations(file, { byEnvironment = false } = {}) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const perEnvironment = new Map();
  const visit = (suite, titles) => {
    for (const test of suite.tests || []) {
      for (const attempt of test.attempts || []) {
        const environment = report.environments[attempt.environmentIdx ?? 0]?.name;
        if (!environment)
          throw new Error(`${file}: an attempt names an environment that is not listed`);
        const key = [environment, ...titles, test.title].join(' › ');
        perEnvironment.set(key, (perEnvironment.get(key) || 0) + (attempt.duration || 0));
      }
    }
    for (const child of suite.suites || []) visit(child, [...titles, child.title]);
  };
  for (const suite of report.suites || []) visit(suite, [suite.title]);
  if (byEnvironment) return perEnvironment;
  const durations = new Map();
  for (const [key, duration] of perEnvironment) {
    const test = key.split(' › ').slice(1).join(' › ');
    durations.set(test, Math.max(durations.get(test) || 0, duration));
  }
  return durations;
}

/**
 * Builds a timings file from Flakiness reports with `build`. `existing` is an earlier timings
 * file folded in first. With `roundMs` the durations are rounded to a multiple of it, so the plan
 * does not depend on a few milliseconds of run-to-run noise. Returns `{ file, call }`.
 */
function buildHistory({ dir, name = 'timings', reports, existing, roundMs, engine = {} }) {
  const output = path.join(dir, `${name}.json`);
  const call = buildTimings(
    { inputs: [...(existing ? [existing] : []), ...reports], output },
    engine
  );
  if (call.status !== 0) throw new Error(`build failed: ${call.stderr}`);
  if (roundMs) roundDurations(output, roundMs);
  return { file: output, call };
}

module.exports = {
  buildHistory,
  execute,
  flakinessReports,
  partitionOf,
  mapDurations,
  roundDurations,
  scaleDurations,
  shardEnv,
  testDurations,
  tempDir,
  violationKinds,
  writeConfig,
};
