'use strict';

/**
 * Footprint of the engine: install size, runtime of each command and the size of the artifacts it
 * adds to a pipeline. Runtimes are the median of repeated calls, including Node start-up.
 */

const fs = require('node:fs');
const path = require('node:path');
const { assign, extractTiming, mergeTiming, packageRoot, runEngine } = require('../engine');
const { chromiumList } = require('./assignment');

const REPEATS = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function repeat(call) {
  return Math.round(median(Array.from({ length: REPEATS }, () => call().ms)));
}

function directoryBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function size(file) {
  return fs.statSync(file).size;
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
