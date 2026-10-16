'use strict';

/**
 * Readers for the artifacts of harness runs that keep Playwright JSON and blob reports: report
 * statistics, attachments, files of a given name and the merge of blob reports.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveFromCwd } = require('./playwright');

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

module.exports = { attachments, blobZips, countFiles, jsonReports, mergeBlobs, readJson, statsOf };
