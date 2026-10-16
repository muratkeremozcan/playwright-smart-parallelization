'use strict';

/**
 * Footprint of the engine: install size, runtime of each command and the size of the artifacts it
 * adds to a pipeline. Runtimes are the median of repeated calls, including Node start-up.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { assign, extractTiming, mergeTiming, packageRoot, runEngine } = require('../engine');
const { directoryBytes, median, size } = require('../../lib/measure');
const { chromiumList } = require('./assignment');

const REPEATS = 5;

function repeat(call) {
  return Math.round(median(Array.from({ length: REPEATS }, () => call().ms)));
}

const RSS_PRELOAD = path.resolve(__dirname, '..', '..', 'lib', 'peak-rss.js');

/**
 * Median peak resident set size, in kilobytes, of `REPEATS` runs of a command. `call` receives
 * the engine call options that load the preload and name its log file.
 */
function peakRss(dir, name, call) {
  const log = path.join(dir, `rss-${name}.log`);
  fs.rmSync(log, { force: true });
  const options = { env: { NODE_OPTIONS: `--require "${RSS_PRELOAD}"`, PSP_RSS_LOG: log } };
  for (let i = 0; i < REPEATS; i += 1) call(options);
  const peaks = fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).maxRssKb);
  if (peaks.length !== REPEATS) throw new Error(`${name}: ${peaks.length} peak readings`);
  return median(peaks);
}

/** Peak memory of an empty Node process, and of each engine command, in kilobytes. */
function memory(dir, { list, timing, report, artifact, merged }) {
  const bare = path.join(dir, 'rss-bare.log');
  fs.rmSync(bare, { force: true });
  const env = { ...process.env, NODE_OPTIONS: `--require "${RSS_PRELOAD}"`, PSP_RSS_LOG: bare };
  for (let i = 0; i < REPEATS; i += 1) spawnSync(process.execPath, ['-e', ''], { env });
  const bareReadings = fs.readFileSync(bare, 'utf8').split('\n').filter(Boolean);
  return {
    bareNode: median(bareReadings.map((line) => JSON.parse(line).maxRssKb)),
    version: peakRss(dir, 'version', (options) => runEngine(['--version'], options)),
    assignCold: peakRss(dir, 'assign-cold', (options) =>
      assign({ testList: list, shards: 3 }, options)
    ),
    assignHistory: peakRss(dir, 'assign-history', (options) =>
      assign({ testList: list, shards: 3, timingFile: timing }, options)
    ),
    extractTiming: peakRss(dir, 'extract', (options) =>
      extractTiming({ reportFile: report, outputFile: artifact, project: 'chromium' }, options)
    ),
    mergeTiming: peakRss(dir, 'merge', (options) =>
      mergeTiming({ existing: timing, artifacts: [artifact], output: merged }, options)
    ),
  };
}

function footprint(ctx) {
  const baseline = ctx.baseline();
  const list = chromiumList(ctx).file;
  const timing = baseline.history.timing.chromium;
  const dir = ctx.dir('footprint');
  const root = path.resolve(__dirname, '..');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const report = baseline.partition[0].env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const artifact = path.join(dir, 'artifact.json');
  const merged = path.join(dir, 'merged.json');
  const assigned = assign({ testList: list, shards: 3, timingFile: timing });

  return {
    install: {
      packages: Object.keys(lock.packages).filter((key) => key !== '').length,
      nodeModulesBytes: directoryBytes(path.join(root, 'node_modules')),
      enginePackageBytes: directoryBytes(packageRoot()),
    },
    runtimeMs: {
      version: repeat(() => runEngine(['--version'])),
      assignCold: repeat(() => assign({ testList: list, shards: 3 })),
      assignHistory: repeat(() => assign({ testList: list, shards: 3, timingFile: timing })),
      extractTiming: repeat(() =>
        extractTiming({ reportFile: report, outputFile: artifact, project: 'chromium' })
      ),
      mergeTiming: repeat(() =>
        mergeTiming({ existing: timing, artifacts: [artifact], output: merged })
      ),
    },
    peakRssKb: memory(dir, { list, timing, report, artifact, merged }),
    artifactBytes: {
      assignmentJson: Buffer.byteLength(assigned.stdout),
      testListPerShard: Object.values(assigned.assignment.testListFiles).map((c) =>
        Buffer.byteLength(c)
      ),
      timingArtifact: size(artifact),
      mergedHistory: size(merged),
      playwrightJsonReport: size(report),
    },
  };
}

module.exports = { footprint };
