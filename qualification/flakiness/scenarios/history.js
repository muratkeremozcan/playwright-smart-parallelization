'use strict';

/**
 * Proof 8 and the history side of proofs 5 and 6: what happens to the timings file when a run
 * fails, is cancelled, loses or damages a report, gets faster, or races another run. The history
 * is the output of `flakiness-playwright-timings build` over the reports of the runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveFromCwd } = require('../../lib/playwright');
const { greenProject, redProject } = require('../../lib/variants');
const { buildTimings } = require('../engine');
const { scrub } = require('../playwright');
const { buildHistory, flakinessReports, scaleDurations, testDurations } = require('../drive');

const CANCEL_AFTER_MS = 300;
const SLOW_FAILURE_MS = 3000;
const FASTER_MS = 100;
// The volatile test, as `testDurations` keys it.
const VOLATILE = 'volatile.spec.js › volatile step';

/** The first line of a stderr text with each path reduced to its file name. */
function message(stderr) {
  return scrub(stderr.split('\n').find((text) => text.trim() !== '') || '').slice(0, 200);
}

/** Reports of the engine's two-shard run with history: the observations of one complete run. */
function runReports(ctx) {
  const reports = flakinessReports(ctx.balancedRun(2).partition);
  if (reports.length === 0) throw new Error('no shard of the balanced run wrote a report');
  return reports;
}

/** The duration of the volatile test in a report or timings file; throws when it is not there. */
function volatileMs(file) {
  const duration = testDurations(file).get(VOLATILE);
  if (duration === undefined) throw new Error(`${path.basename(file)} has no volatile test`);
  return duration;
}

function reportAndHistory(ctx, name) {
  const dir = ctx.dir(name);
  return { dir, base: ctx.baseline().history.file, reports: runReports(ctx) };
}

/** A shard report missing, or damaged, when history is built. */
function shardReports(ctx) {
  const { dir, reports } = reportAndHistory(ctx, 'shard-reports');
  const [first] = reports;
  const complete = buildHistory({ dir, name: 'complete', reports });
  const partial = buildHistory({ dir, name: 'partial', reports: [first] });
  const absent = buildTimings({
    inputs: [first, path.join(dir, 'absent-shard-2.json')],
    output: path.join(dir, 'absent.json'),
  });
  const completeTests = testDurations(complete.file).size;
  const partialTests = testDurations(partial.file).size;
  return {
    id: '6.missing-shard-report',
    proof: 6,
    title: 'the report of shard 2 is missing when history is built',
    status: partialTests < completeTests ? 'fail' : 'pass',
    evidence: {
      buildExit: partial.call.status,
      testsWithCompleteInput: completeTests,
      testsWithOneReport: partialTests,
      unreadableInputExit: absent.status,
      unreadableInputMessage: message(absent.stderr),
    },
  };
}

/** A damaged input of `build`: it must fail and leave the file it would write untouched. */
function damagedInputs(ctx) {
  const { dir, base, reports } = reportAndHistory(ctx, 'damaged-inputs');
  const damagedHistory = path.join(dir, 'damaged-history.json');
  fs.writeFileSync(damagedHistory, fs.readFileSync(base, 'utf8').slice(0, 300));
  const damagedReport = path.join(dir, 'damaged-report.json');
  fs.writeFileSync(damagedReport, fs.readFileSync(reports[0], 'utf8').slice(0, 300));
  const attempt = (inputs) => {
    const output = path.join(dir, 'published.json');
    fs.copyFileSync(base, output);
    const before = fs.readFileSync(output, 'utf8');
    const call = buildTimings({ inputs, output });
    return {
      exit: call.status,
      message: message(call.stderr),
      outputUnchanged: fs.readFileSync(output, 'utf8') === before,
    };
  };
  const history = attempt([damagedHistory, reports[0]]);
  const report = attempt([base, damagedReport]);
  return {
    id: '8.damaged-history',
    proof: 8,
    title: 'the existing history, or a new report, is damaged when history is built',
    status: [history, report].every((run) => run.exit !== 0 && run.outputUnchanged)
      ? 'pass'
      : 'fail',
    evidence: { damagedHistory: history, damagedReport: report },
  };
}

/** The history entry of the volatile test before and after a run is merged into it. */
function mergedVolatile(ctx, { name, run, history }) {
  const merged = buildHistory({
    dir: ctx.dir(name),
    reports: flakinessReports(run.partition),
    existing: history,
  });
  return {
    before: volatileMs(history),
    after: volatileMs(merged.file),
  };
}

/** The volatile variants: a passing run as history, and failing runs of the same test. */
function volatileRuns(ctx) {
  const green = ctx.baseline({ name: 'volatile-green', cwd: greenProject(ctx) });
  const options = {
    cwd: redProject(ctx),
    shards: 2,
    timings: green.history.file,
    workers: 1,
    forward: ['--grep', 'volatile'],
  };
  const fast = ctx.run({ name: 'volatile-fail-fast', ...options });
  const slow = ctx.run({
    name: 'volatile-fail-slow',
    ...options,
    env: { PSP_FAIL_AFTER_MS: String(SLOW_FAILURE_MS) },
  });
  return { green, fast, slow };
}

function failedRuns(ctx) {
  const { green, fast, slow } = volatileRuns(ctx);
  const history = green.history.file;
  const quick = mergedVolatile(ctx, { name: 'merge-fail-fast', run: fast, history });
  const late = mergedVolatile(ctx, { name: 'merge-fail-slow', run: slow, history });
  return [
    {
      id: '8.failed-run',
      proof: 8,
      title: 'a run where the volatile test fails at once is merged into history',
      status: quick.after >= quick.before * 0.9 ? 'pass' : 'fail',
      evidence: { testId: VOLATILE, durationBeforeMs: quick.before, durationAfterMs: quick.after },
    },
    {
      id: '8.failed-run-slow',
      proof: 8,
      title: `a run where the volatile test fails after ${SLOW_FAILURE_MS} ms is merged into history`,
      status: Math.abs(late.after - late.before) <= late.before * 0.05 ? 'pass' : 'fail',
      evidence: { testId: VOLATILE, durationBeforeMs: late.before, durationAfterMs: late.after },
    },
  ];
}

/** Runs the volatile test alone, unsharded, and returns the report the reporter wrote. */
function singleRun(ctx, { name, env }) {
  const cwd = greenProject(ctx);
  const dir = ctx.dir(name);
  const result = spawnSync(
    process.execPath,
    [
      resolveFromCwd('@playwright/test/cli', cwd),
      'test',
      `--config=${ctx.config(cwd)}`,
      '--workers=1',
      '--project=chromium',
      '--grep',
      'volatile step',
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, FLAKINESS_OUTPUT_DIR: dir, ...env },
    }
  );
  return { exit: result.status, report: path.join(dir, 'report.json'), dir };
}

/** A run cancelled with SIGINT while the volatile test executes. */
function cancelledRun(ctx) {
  const history = volatileRuns(ctx).green.history.file;
  const run = singleRun(ctx, {
    name: 'cancelled',
    env: { PSP_CANCEL_AFTER_MS: String(CANCEL_AFTER_MS) },
  });
  if (!fs.existsSync(run.report)) {
    return {
      id: '8.cancelled-run',
      proof: 8,
      title: `a run cancelled with SIGINT ${CANCEL_AFTER_MS} ms into a test is merged into history`,
      status: 'fail',
      evidence: { exit: run.exit, reportWritten: false },
    };
  }
  const cancelled = volatileMs(run.report);
  const merged = buildHistory({ dir: run.dir, reports: [run.report], existing: history });
  const before = volatileMs(history);
  const after = volatileMs(merged.file);
  return {
    id: '8.cancelled-run',
    proof: 8,
    title: `a run cancelled with SIGINT ${CANCEL_AFTER_MS} ms into a test is merged into history`,
    status: after >= before * 0.9 ? 'pass' : 'fail',
    evidence: {
      exit: run.exit,
      reportWritten: cancelled !== undefined,
      cancelledAttemptMs: cancelled ?? null,
      durationBeforeMs: before,
      durationAfterMs: after,
    },
  };
}

/** A test that became ten times faster, merged into history. */
function fasterTest(ctx) {
  const history = volatileRuns(ctx).green.history.file;
  const run = singleRun(ctx, { name: 'faster', env: { PSP_VOLATILE_MS: String(FASTER_MS) } });
  const merged = buildHistory({ dir: run.dir, reports: [run.report], existing: history });
  const before = volatileMs(history);
  const after = volatileMs(merged.file);
  return {
    id: '8.faster-test',
    proof: 8,
    title: `a test that now takes ${FASTER_MS} ms instead of a second is merged into history`,
    status: after < before * 0.9 ? 'pass' : 'fail',
    evidence: {
      newRunMs: volatileMs(run.report),
      durationBeforeMs: before,
      durationAfterMs: after,
    },
  };
}

/**
 * Integration: history rebuilt from the reports of a window of recent passing runs, instead of
 * folded into the previous timings file. A faster test shows its new duration once the slow
 * observation leaves the window, a failed run left out of the window changes nothing, and a slow
 * passing run still inside the window holds the entry up until it leaves.
 */
function windowRebuild(ctx) {
  const { green, slow } = volatileRuns(ctx);
  const dir = ctx.dir('window');
  const greenReports = flakinessReports(green.partition);
  const faster = singleRun(ctx, {
    name: 'window-faster',
    env: { PSP_VOLATILE_MS: String(FASTER_MS) },
  });
  const before = volatileMs(green.history.file);
  const windowed = buildHistory({ dir, name: 'windowed', reports: [faster.report] });
  const withFailure = buildHistory({
    dir,
    name: 'with-failure',
    reports: [...greenReports, ...flakinessReports(slow.partition)],
  });
  const withoutFailure = buildHistory({ dir, name: 'without-failure', reports: greenReports });
  // A window of the two latest runs: the faster run and the slower passing run before it.
  const slowPassing = buildHistory({
    dir,
    name: 'slow-passing',
    reports: [faster.report, ...greenReports],
  });
  const after = volatileMs(windowed.file);
  const failed = volatileMs(withFailure.file);
  const kept = volatileMs(withoutFailure.file);
  const inside = volatileMs(slowPassing.file);
  return {
    id: '8.window-rebuild',
    proof: 8,
    subject: 'integration',
    title: 'history rebuilt from the reports of a window of recent passing runs',
    status:
      after < before * 0.9 &&
      failed > before * 1.5 &&
      kept <= before * 1.05 &&
      inside >= before * 0.95
        ? 'pass'
        : 'fail',
    evidence: {
      durationBeforeMs: before,
      durationInFasterWindowMs: after,
      durationWithFailedRunInWindowMs: failed,
      durationWithFailedRunLeftOutMs: kept,
      durationWithSlowPassingRunInWindowMs: inside,
    },
  };
}

/** Two runs merge into the same base history, then publish in the opposite order. */
function racingPublish(ctx) {
  const { dir, base, reports } = reportAndHistory(ctx, 'race');
  const newer = reports.map((file, index) =>
    scaleDurations(file, 1.5, path.join(dir, `newer-${index + 1}.json`))
  );
  const afterNewer = buildHistory({ dir, name: 'newer', existing: base, reports: newer });
  const afterOlder = buildHistory({ dir, name: 'older', existing: base, reports });
  // The newer run merges first; the older run is delayed and merges, then publishes, last.
  const sequential = buildHistory({
    dir,
    name: 'sequential',
    existing: afterNewer.file,
    reports,
  });
  const expected = testDurations(sequential.file);
  const published = testDurations(afterOlder.file);
  const lost = [...expected].filter(([key, duration]) => duration > (published.get(key) ?? 0));
  const file = JSON.parse(fs.readFileSync(afterOlder.file, 'utf8'));
  return {
    id: 'x2.racing-publish',
    proof: 'x2',
    title: 'two runs merge into the same base and publish in the opposite order',
    status: lost.length === 0 ? 'pass' : 'fail',
    evidence: {
      testsInHistory: published.size,
      updatesLost: lost.length,
      startTimestamp: file.startTimestamp,
      carriesRunIdentity: file.startTimestamp !== 0,
      topLevelKeys: Object.keys(file).sort(),
    },
  };
}

module.exports = {
  cancelledRun,
  damagedInputs,
  failedRuns,
  fasterTest,
  racingPublish,
  shardReports,
  windowRebuild,
};
