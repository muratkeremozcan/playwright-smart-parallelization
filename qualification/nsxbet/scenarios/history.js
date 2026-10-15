'use strict';

/**
 * Proof 8 and the timing side of proofs 5 and 6: what happens to the timing history when a run
 * fails, is cancelled, loses or damages a shard artifact, or races another run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveFromCwd } = require('../../../harness');
const { buildHistory, filterProjects, reportFiles, writeJson } = require('../drive');
const { extractTiming, mergeTiming } = require('../engine');
const { VOLATILE_ID, greenProject, redRun } = require('../variants');

const CANCEL_AFTER_MS = 300;

/**
 * The messages of an oclif stderr: wrapped lines (they start with a space and a `›`) are joined to
 * the line they continue, and each absolute path is replaced by its file name.
 */
function messages(stderr) {
  const joined = [];
  for (const line of stderr.split('\n').filter((text) => text.trim() !== '')) {
    const continuation = /^\s+›\s*/.exec(line);
    if (continuation && joined.length > 0)
      joined[joined.length - 1] += line.slice(continuation[0].length);
    else joined.push(line.replace(/^›\s*/, ''));
  }
  return joined.map((line) => line.replace(/(?:\/[^\s/]+)+\/([^\s/]+)/g, '$1'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Per-shard chromium timing artifacts of the engine's two-shard run with history. */
function chromiumArtifacts(ctx) {
  return ctx.once('engine-artifacts', () => {
    const run = ctx.engineHistoryRun(2);
    const dir = ctx.dir('engine-artifacts');
    buildHistory({ dir, reports: reportFiles(run.partition), listing: ctx.listing() });
    return [1, 2].map((shard) => path.join(dir, `timing-chromium-shard-${shard}.json`));
  });
}

function mergeRow({ id, proof, title, files, ctx }) {
  const existing = ctx.baseline().history.timing.chromium;
  const output = path.join(ctx.dir('merge'), `${id}.json`);
  const call = mergeTiming({ existing, artifacts: files, output });
  const before = readJson(existing);
  const after = fs.existsSync(output) ? readJson(output) : null;
  const touched = after
    ? Object.keys(after.tests).filter(
        (key) => after.tests[key].runs > (before.tests[key]?.runs || 0)
      )
    : [];
  return {
    id,
    proof,
    title,
    status: call.status !== 0 ? 'pass' : 'fail',
    evidence: {
      exit: call.status,
      stderr: messages(call.stderr),
      testsBefore: Object.keys(before.tests).length,
      testsAfter: after ? Object.keys(after.tests).length : null,
      testsUpdated: touched.length,
    },
  };
}

/** A damaged or missing shard artifact at merge time. */
function shardArtifacts(ctx) {
  const [first, second] = chromiumArtifacts(ctx);
  const dir = ctx.dir('merge');
  const damaged = path.join(dir, 'damaged-shard-2.json');
  fs.writeFileSync(damaged, fs.readFileSync(second, 'utf8').slice(0, 120));
  return [
    mergeRow({
      id: 'x1.damaged-shard-artifact',
      proof: 'x1',
      title: 'shard 2 timing artifact damaged when history is merged',
      files: [first, damaged],
      ctx,
    }),
    mergeRow({
      id: '6.missing-timing-artifact',
      proof: 6,
      title: 'shard 2 timing artifact missing when history is merged',
      files: [first, path.join(dir, 'absent-shard-2.json')],
      ctx,
    }),
  ];
}

function damagedExisting(ctx) {
  const existing = ctx.baseline().history.timing.chromium;
  const [first] = chromiumArtifacts(ctx);
  const dir = ctx.dir('merge');
  const damaged = path.join(dir, 'damaged-history.json');
  fs.writeFileSync(damaged, fs.readFileSync(existing, 'utf8').slice(0, 300));
  const output = path.join(dir, 'after-damaged-history.json');
  const call = mergeTiming({ existing: damaged, artifacts: [first], output });
  const before = Object.keys(readJson(existing).tests).length;
  const after = fs.existsSync(output) ? Object.keys(readJson(output).tests).length : null;
  return {
    id: '8.damaged-history',
    proof: 8,
    title: 'the existing history file is damaged when one shard artifact is merged',
    status: call.status !== 0 || after >= before ? 'pass' : 'fail',
    evidence: {
      exit: call.status,
      stderr: messages(call.stderr),
      testsBefore: before,
      testsAfter: after,
    },
  };
}

/** A copy of a timing artifact whose durations are `factor` times as long. */
function scaled(file, factor, output) {
  const artifact = readJson(file);
  for (const id of Object.keys(artifact.tests)) {
    artifact.tests[id] = Math.round(artifact.tests[id] * factor);
  }
  return writeJson(output, artifact);
}

/** Two runs merge into the same base history, then publish in the opposite order. */
function racingPublish(ctx) {
  const existing = ctx.baseline().history.timing.chromium;
  const olderRun = chromiumArtifacts(ctx);
  const dir = ctx.dir('race');
  const newerRun = olderRun.map((file, index) =>
    scaled(file, 1.5, path.join(dir, `newer-${index + 1}.json`))
  );
  const merged = (name, from, artifacts) => {
    const output = path.join(dir, name);
    mergeTiming({ existing: from, artifacts, output });
    return output;
  };
  // The newer run merges first; the older run is delayed and merges, then publishes, last.
  const afterNewer = merged('newer.json', existing, newerRun);
  const afterOlder = merged('older.json', existing, olderRun);
  const sequential = readJson(merged('sequential.json', afterNewer, olderRun));
  const published = readJson(afterOlder);
  const lost = Object.keys(sequential.tests).filter(
    (key) => sequential.tests[key].runs > (published.tests[key]?.runs ?? 0)
  );
  const entry = Object.values(published.tests)[0];
  return {
    id: 'x2.racing-publish',
    proof: 'x2',
    title: 'two runs merge into the same base and publish in the opposite order',
    status: lost.length === 0 ? 'pass' : 'fail',
    evidence: {
      testsInHistory: Object.keys(published.tests).length,
      updatesLost: lost.length,
      publishedUpdatedAt: published.updatedAt,
      newerRunUpdatedAt: readJson(afterNewer).updatedAt,
      publishedIsLaterThanNewerRun: published.updatedAt >= readJson(afterNewer).updatedAt,
      entryKeys: Object.keys(entry).sort(),
      topLevelKeys: Object.keys(published).sort(),
    },
  };
}

/** Folds the JSON reports of a run into a copy of the chromium history. */
function mergeRun(ctx, name, reports, listing, existing) {
  const dir = ctx.dir(name);
  const { timing } = buildHistory({ dir, reports, listing, existing: { chromium: existing } });
  return readJson(timing.chromium);
}

/** A failing run: the volatile test fails at once where its history says one second. */
function failedRun(ctx) {
  const { green, red, cwd } = redRun(ctx);
  const listing = ctx.listing({ cwd });
  const before = readJson(green.history.timing.chromium);
  const after = mergeRun(
    ctx,
    'volatile-merge',
    reportFiles(red.partition),
    listing,
    green.history.timing.chromium
  );
  const previous = before.tests[VOLATILE_ID].duration;
  const next = after.tests[VOLATILE_ID].duration;
  return {
    id: '8.failed-run',
    proof: 8,
    title: 'a run where the volatile test fails at once is merged into history',
    status: next >= previous * 0.9 ? 'pass' : 'fail',
    evidence: { testId: VOLATILE_ID, durationBeforeMs: previous, durationAfterMs: next },
  };
}

/** Engine ids (`file::titles`) of the tests that have an interrupted result in a JSON report. */
function interruptedIds(report) {
  const ids = [];
  const visit = (suite, file, titles) => {
    for (const spec of suite.specs || []) {
      const hit = spec.tests.some((test) => test.results.some((r) => r.status === 'interrupted'));
      if (hit) ids.push([file, ...titles, spec.title].join('::'));
    }
    for (const child of suite.suites || []) visit(child, file, [...titles, child.title]);
  };
  for (const root of report.suites) visit(root, root.file, []);
  return ids;
}

/**
 * A run cancelled with SIGINT while the volatile test is executing. The test cancels its own run
 * 300 ms in, through `PSP_CANCEL_AFTER_MS`, so the cancellation lands inside the test every time.
 */
function cancelledRun(ctx) {
  const green = greenProject(ctx);
  const history = ctx.baseline({ name: 'volatile-green', cwd: green }).history.timing.chromium;
  const dir = ctx.dir('cancelled');
  const report = path.join(dir, 'report.json');
  const cli = resolveFromCwd('@playwright/test/cli', green);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'test',
      '--reporter=json',
      '--workers=1',
      '--project=chromium',
      '--grep',
      'volatile step',
    ],
    {
      cwd: green,
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: report,
        PSP_CANCEL_AFTER_MS: String(CANCEL_AFTER_MS),
      },
      stdio: 'ignore',
    }
  );
  const parsed = readJson(report);
  const interrupted = interruptedIds(parsed);
  if (interrupted.length === 0) throw new Error('the cancelled run has no interrupted test');
  const artifact = path.join(dir, 'timing.json');
  const kept = filterProjects(parsed, ['chromium', 'setup', 'teardown']);
  const extracted = extractTiming({
    reportFile: writeJson(path.join(dir, 'chromium-report.json'), kept),
    outputFile: artifact,
    project: 'chromium',
  });
  const timings = readJson(artifact).tests;
  const recorded = interrupted.filter((id) => id in timings);
  return {
    id: '8.cancelled-run',
    proof: 8,
    title: `a run cancelled with SIGINT ${CANCEL_AFTER_MS} ms into a test is merged into history`,
    status: recorded.length === 0 ? 'pass' : 'fail',
    evidence: {
      exit: result.status,
      extractExit: extracted.status,
      interrupted: interrupted.map((id) => ({
        id,
        recordedMs: timings[id] ?? null,
        historyMs: readJson(history).tests[id]?.duration ?? null,
      })),
    },
  };
}

module.exports = {
  cancelledRun,
  damagedExisting,
  failedRun,
  racingPublish,
  shardArtifacts,
};
