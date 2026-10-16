'use strict';

/**
 * Proof 6: exit codes, retries, attachments, the Flakiness report, blob and merged reports of a
 * run that executes through the engine, compared with native sharding of the same failing project.
 */

const fs = require('node:fs');
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
const { coverageKinds } = require('../../lib/scoring');
const { redProject } = require('../../lib/variants');
const { flakinessReports, testDurations } = require('../drive');
const { greenBaseline } = require('./volatile');

// The volatile test runs in two projects and fails on all three attempts (retries: 2).
const EXPECTED_ATTEMPTS = 6;

/** The failing variant: balanced from the passing variant's history, and natively without the reporter. */
function redRuns(ctx) {
  const cwd = redProject(ctx);
  const green = greenBaseline(ctx);
  const red = ctx.run({
    name: 'volatile-red',
    cwd,
    shards: 2,
    timings: green.history.file,
    json: true,
    blob: true,
    output: true,
  });
  const native = ctx.run({ name: 'volatile-red-native', cwd, shards: 2, plain: true, json: true });
  return { cwd, red, native };
}

/** Attachment references the Flakiness reports hold, and how many of them point at a stored file. */
function reportAttachments(partition) {
  let references = 0;
  let stored = 0;
  const names = {};
  for (const file of flakinessReports(partition)) {
    const report = readJson(file);
    const folder = path.join(path.dirname(file), 'attachments');
    const visit = (suite) => {
      for (const test of suite.tests || []) {
        for (const attempt of test.attempts) {
          for (const attachment of attempt.attachments || []) {
            references += 1;
            names[attachment.name] = (names[attachment.name] || 0) + 1;
            if (fs.existsSync(path.join(folder, attachment.id))) stored += 1;
          }
        }
      }
      (suite.suites || []).forEach(visit);
    };
    report.suites.forEach(visit);
  }
  return { references, stored, names };
}

function reportProofs(ctx) {
  const { cwd, red, native } = redRuns(ctx);
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

  const reports = flakinessReports(red.partition);
  const reported = reports.reduce(
    (total, file) => total + testDurations(file, { byEnvironment: true }).size,
    0
  );
  const executed = red.raw.reduce((total, shard) => total + (shard.leaves || []).length, 0);
  const held = reportAttachments(red.partition);

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
      title:
        'attachments, API request traces, blob reports and the Flakiness report are produced and complete',
      status:
        traces === EXPECTED_ATTEMPTS &&
        notes === EXPECTED_ATTEMPTS &&
        zips.length === 2 &&
        merged.exit === 0 &&
        sum(merged.stats) === engineTotal &&
        reports.length === 2 &&
        reported === executed &&
        held.names.note === EXPECTED_ATTEMPTS &&
        held.stored === held.references
          ? 'pass'
          : 'fail',
      evidence: {
        traceFiles: traces,
        noteAttachments: notes,
        blobReports: zips.length,
        mergedTotal: merged.stats && sum(merged.stats),
        shardTotal: engineTotal,
        flakinessReports: reports.length,
        testsInFlakinessReports: reported,
        testsExecuted: executed,
        attachmentReferences: held.references,
        attachmentReferencesByName: held.names,
        attachmentsStored: held.stored,
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
