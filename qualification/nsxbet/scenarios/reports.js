'use strict';

/**
 * Proof 6: exit codes, retries, attachments, traces, blob and merged reports of a run that
 * executes through the engine, compared with native sharding of the same failing project.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveFromCwd } = require('../../../harness');
const { coverageKinds } = require('./coverage');
const { redRun } = require('../variants');

// The volatile test runs in two projects and fails on all three attempts (retries: 2).
const EXPECTED_ATTEMPTS = 6;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function statsOf(files) {
  const total = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const file of files) {
    const stats = readJson(file).stats;
    for (const key of Object.keys(total)) total[key] += stats[key];
  }
  return total;
}

function jsonReports(partition) {
  return partition.map((shard) => shard.env.PLAYWRIGHT_JSON_OUTPUT_FILE);
}

function countFiles(root, name) {
  let found = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === name && fs.statSync(full).size > 0) found += 1;
    }
  };
  if (fs.existsSync(root)) visit(root);
  return found;
}

function attachments(files, name) {
  let count = 0;
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests) {
        for (const result of test.results) {
          count += (result.attachments || []).filter((a) => a.name === name).length;
        }
      }
    }
    (suite.suites || []).forEach(visit);
  };
  for (const file of files) readJson(file).suites.forEach(visit);
  return count;
}

/** Merges the blob reports of the shards in `zips` and returns `{ exit, stats }`. */
function mergeBlobs(cwd, dir, zips) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  zips.forEach((zip, index) => fs.copyFileSync(zip, path.join(dir, `shard-${index + 1}.zip`)));
  const cli = resolveFromCwd('@playwright/test/cli', cwd);
  const output = path.join(dir, 'merged.json');
  const result = spawnSync(process.execPath, [cli, 'merge-reports', '--reporter=json', dir], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: output },
  });
  const report = result.status === 0 ? readJson(output) : null;
  return { exit: result.status, stats: report && report.stats };
}

function blobZips(partition) {
  return partition.flatMap((shard) => {
    const dir = shard.env.PLAYWRIGHT_BLOB_OUTPUT_DIR;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => path.join(dir, f));
  });
}

function reportProofs(ctx) {
  const { cwd, red } = redRun(ctx);
  const native = ctx.baseline({ name: 'volatile-red-native', cwd });
  const engineFiles = jsonReports(red.partition);
  const nativeFiles = jsonReports(native.partition);
  const engineStats = statsOf(engineFiles);
  const nativeStats = statsOf(nativeFiles);
  const failedShards = red.summary.shards.filter((s) => s.exitCode !== 0).map((s) => s.index);
  const shardsWithFailedTest = engineFiles
    .map((file, index) => (readJson(file).stats.unexpected > 0 ? index + 1 : null))
    .filter(Boolean);

  const outputs = red.partition.map((shard) =>
    shard.args.find((a) => a.startsWith('--output=')).slice(9)
  );
  const traces = outputs.reduce((sum, dir) => sum + countFiles(dir, 'api-trace.zip'), 0);
  const zips = blobZips(red.partition);
  const dir = ctx.dir('blob-merge');
  const merged = mergeBlobs(cwd, path.join(dir, 'all'), zips);
  const partial = mergeBlobs(cwd, path.join(dir, 'one'), zips.slice(0, 1));
  const notes = attachments(engineFiles, 'note');
  const sum = (stats) => stats.expected + stats.unexpected + stats.flaky + stats.skipped;
  const engineTotal = sum(engineStats);

  return [
    {
      id: '6.exit-codes',
      proof: 6,
      title: 'the shards that exit non-zero are the shards that report a failed test',
      status:
        engineStats.unexpected === nativeStats.unexpected &&
        failedShards.length > 0 &&
        JSON.stringify(failedShards) === JSON.stringify(shardsWithFailedTest) &&
        Object.keys(coverageKinds(red.summary.kinds)).length === 0
          ? 'pass'
          : 'fail',
      evidence: {
        failedShards,
        shardsWithFailedTest,
        unexpectedEngine: engineStats.unexpected,
        unexpectedNative: nativeStats.unexpected,
        kinds: red.summary.kinds,
      },
    },
    {
      id: '6.retries',
      proof: 6,
      title: 'retried tests keep their flaky outcome',
      status: engineStats.flaky === nativeStats.flaky && engineStats.flaky > 0 ? 'pass' : 'fail',
      evidence: { flakyEngine: engineStats.flaky, flakyNative: nativeStats.flaky },
    },
    {
      id: '6.artifacts',
      proof: 6,
      title: 'attachments, API request traces and blob reports are produced and merge completely',
      status:
        traces === EXPECTED_ATTEMPTS &&
        notes === EXPECTED_ATTEMPTS &&
        zips.length === 2 &&
        merged.exit === 0 &&
        sum(merged.stats) === engineTotal
          ? 'pass'
          : 'fail',
      evidence: {
        traceFiles: traces,
        noteAttachments: notes,
        blobReports: zips.length,
        mergedTotal: merged.stats && sum(merged.stats),
        shardTotal: engineTotal,
      },
    },
    {
      id: '6.missing-blob',
      proof: 6,
      subject: 'playwright',
      title: 'a shard blob report is missing when reports are merged',
      status: partial.exit !== 0 ? 'pass' : 'fail',
      evidence: {
        exit: partial.exit,
        mergedTotal: partial.stats && sum(partial.stats),
        completeTotal: sum(merged.stats),
      },
    },
  ];
}

module.exports = { reportProofs };
