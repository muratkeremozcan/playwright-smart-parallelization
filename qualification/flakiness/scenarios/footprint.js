'use strict';

/**
 * Footprint of the engine against a plain native run: install size, the runtime and memory the
 * reporter adds to a Playwright run, the artifacts it writes, and the timings command. An offline
 * reporter is not timing-only: it builds a report, collects sources and attachments and samples
 * CPU and memory, and these numbers measure what that costs. Runs alternate between the plain
 * run and the run with the reporter, and the figures are medians.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveFromCwd } = require('../../lib/playwright');
const { directoryBytes, median, size } = require('../../lib/measure');
const { readJson } = require('../../lib/artifacts');
const { buildTimings, packageRoot, runTimings } = require('../engine');
const { flakinessReports } = require('../drive');
const { guardedRun, spawnsOf } = require('./network');

const REPEATS = 5;
const RSS_PRELOAD = path.resolve(__dirname, '..', '..', 'lib', 'peak-rss.js');
const WORKERS = 4;

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * The moment the last test result of a run ended, from its Playwright JSON report: the latest
 * start plus duration of any result. The run's own duration also covers global teardown, which
 * is not report generation.
 */
function lastTestEnd(report) {
  let latest = 0;
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests) {
        for (const result of test.results) {
          latest = Math.max(latest, Date.parse(result.startTime) + result.duration);
        }
      }
    }
    (suite.suites || []).forEach(visit);
  };
  report.suites.forEach(visit);
  if (latest === 0) throw new Error('the report holds no test result');
  return latest;
}

/**
 * One unsharded run of the fixture with `WORKERS` workers, plain or with the reporter. Returns the
 * wall time, the time between the last test and the exit of the process, the peak memory of the Playwright process
 * and of its largest worker, and the folder the reporter wrote.
 */
function playwrightRun(ctx, { label, plain }) {
  const dir = ctx.dir(`footprint-${label}`);
  const rssLog = path.join(dir, 'rss.log');
  const jsonReport = path.join(dir, 'report.json');
  const reportDir = path.join(dir, 'flakiness');
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [
      resolveFromCwd('@playwright/test/cli', ctx.cwd),
      'test',
      `--config=${ctx.config()}`,
      `--workers=${WORKERS}`,
      // One shard of one: the reporter runs its whole balancing pass on the same tests the
      // plain run executes.
      '--shard=1/1',
    ],
    {
      cwd: ctx.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${RSS_PRELOAD}"`,
        PSP_RSS_LOG: rssLog,
        PSP_FLK_EXTRA: 'json',
        PLAYWRIGHT_JSON_OUTPUT_FILE: jsonReport,
        FLAKINESS_OUTPUT_DIR: reportDir,
        ...(plain ? { PSP_FLK_PLAIN: '1' } : { PSP_FLK_TIMINGS: ctx.baseline().history.file }),
      },
    }
  );
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const exitedAt = Date.now();
  if (result.status !== 0) {
    throw new Error(`footprint run ${label} failed: ${result.stderr}${result.stdout.slice(-2000)}`);
  }
  const peaks = readLines(rssLog);
  const main = peaks.filter((entry) => !entry.ipc);
  const workers = peaks.filter((entry) => entry.ipc);
  if (workers.length === 0) throw new Error(`${label}: no worker process logged`);
  if (main.length !== 1) throw new Error(`${label}: ${main.length} Playwright processes`);
  return {
    wallMs,
    afterLastTestMs: exitedAt - lastTestEnd(readJson(jsonReport)),
    mainRssKb: main[0].maxRssKb,
    workerRssKb: Math.max(...workers.map((entry) => entry.maxRssKb)),
    workers: workers.length,
    jsonReport,
    reportDir,
  };
}

/** Alternating plain and reporter runs; medians of each figure. */
function runtimeAndMemory(ctx) {
  const plain = [];
  const withReporter = [];
  for (let i = 0; i < REPEATS; i += 1) {
    plain.push(playwrightRun(ctx, { label: `plain-${i}`, plain: true }));
    withReporter.push(playwrightRun(ctx, { label: `reporter-${i}`, plain: false }));
  }
  const med = (runs, pick) => Math.round(median(runs.map(pick)));
  const summary = (runs) => ({
    wallMs: med(runs, (run) => run.wallMs),
    wallMinMs: Math.round(Math.min(...runs.map((run) => run.wallMs))),
    wallMaxMs: Math.round(Math.max(...runs.map((run) => run.wallMs))),
    afterTestsMs: med(runs, (run) => run.afterLastTestMs),
    mainRssKb: med(runs, (run) => run.mainRssKb),
    workerRssKb: med(runs, (run) => run.workerRssKb),
  });
  return {
    runs: REPEATS,
    workers: WORKERS,
    plain: summary(plain),
    reporter: summary(withReporter),
    last: withReporter.at(-1),
  };
}

/** Median runtime and peak memory of the timings command over `REPEATS` calls. */
function commandFigures(dir, name, args) {
  const log = path.join(dir, `rss-${name}.log`);
  fs.rmSync(log, { force: true });
  const times = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const call = runTimings(args, {
      env: { NODE_OPTIONS: `--require "${RSS_PRELOAD}"`, PSP_RSS_LOG: log },
    });
    if (call.status !== 0) throw new Error(`${name} failed: ${call.stderr}`);
    times.push(call.ms);
  }
  const peaks = readLines(log).map((entry) => entry.maxRssKb);
  if (peaks.length !== REPEATS) throw new Error(`${name}: ${peaks.length} peak readings`);
  return { ms: Math.round(median(times)), rssKb: median(peaks) };
}

function bareNodeRss(dir) {
  const log = path.join(dir, 'rss-bare.log');
  fs.rmSync(log, { force: true });
  const env = { ...process.env, NODE_OPTIONS: `--require "${RSS_PRELOAD}"`, PSP_RSS_LOG: log };
  for (let i = 0; i < REPEATS; i += 1) spawnSync(process.execPath, ['-e', ''], { env });
  return median(readLines(log).map((entry) => entry.maxRssKb));
}

function footprint(ctx) {
  const baseline = ctx.baseline();
  const dir = ctx.dir('footprint');
  const root = path.resolve(__dirname, '..');
  const lock = readJson(path.join(root, 'package-lock.json'));
  const measured = runtimeAndMemory(ctx);
  const reportFile = path.join(measured.last.reportDir, 'report.json');
  const report = readJson(reportFile);
  const [oneReport] = flakinessReports(baseline.partition);
  if (!oneReport) throw new Error('the baseline wrote no Flakiness report');
  const timings = baseline.history.file;
  const built = path.join(dir, 'built.json');
  const builtMerged = path.join(dir, 'built-merged.json');
  buildTimings({ inputs: [oneReport], output: built });
  const guarded = spawnsOf(guardedRun(ctx, { label: 'guard' }).entries);

  const help = commandFigures(dir, 'help', ['--help']);
  const buildOne = commandFigures(dir, 'build-one', ['build', oneReport, '-o', built]);
  const buildMerge = commandFigures(dir, 'build-merge', [
    'build',
    timings,
    oneReport,
    '-o',
    builtMerged,
  ]);

  return {
    install: {
      packages: Object.keys(lock.packages).filter((key) => key !== '').length,
      nodeModulesBytes: directoryBytes(path.join(root, 'node_modules')),
      enginePackageBytes: directoryBytes(packageRoot()),
    },
    playwright: {
      runs: measured.runs,
      workers: measured.workers,
      plain: measured.plain,
      reporter: measured.reporter,
    },
    timingsCommand: {
      runtimeMs: { help: help.ms, buildOne: buildOne.ms, buildMerge: buildMerge.ms },
      peakRssKb: {
        bareNode: bareNodeRss(dir),
        help: help.rssKb,
        buildOne: buildOne.rssKb,
        buildMerge: buildMerge.rssKb,
      },
    },
    artifactBytes: {
      flakinessReport: size(reportFile),
      flakinessFolder: directoryBytes(measured.last.reportDir),
      playwrightJsonReport: size(measured.last.jsonReport),
      timingsFile: size(built),
    },
    reportContent: {
      sourceFiles: report.sources.length,
      cpuSamples: report.cpuAvg.length,
      ramSamples: report.ram.length,
    },
    probeProcesses: guarded.programs,
  };
}

module.exports = { footprint, lastTestEnd };
