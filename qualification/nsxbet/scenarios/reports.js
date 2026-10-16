'use strict';

/**
 * Proof 6: exit codes, retries, attachments, traces, blob and merged reports of a run that
 * executes through the engine, compared with native sharding of the same failing project.
 */

const path = require('node:path');
const {
  attachments,
  blobZips,
  countFiles,
  jsonReports,
  mergeBlobs,
  readJson,
  statsOf,
} = require('../../lib/artifacts');
const { coverageKinds } = require('./coverage');
const { redRun } = require('../variants');

// The volatile test runs in two projects and fails on all three attempts (retries: 2).
const EXPECTED_ATTEMPTS = 6;

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
        completeTotal: merged.stats && sum(merged.stats),
      },
    },
  ];
}

module.exports = { reportProofs };
