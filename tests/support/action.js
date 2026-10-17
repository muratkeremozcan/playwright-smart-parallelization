'use strict';

/**
 * Shards of the Action's reporter as harness partitions, and the records they write. A shard is
 * `{ args, env }`: `--shard=i/n` and one `--add-reporter` value that holds the harness reporter
 * and the Action's, since Playwright keeps only the last `--add-reporter`, and the reporter's
 * options in the environment, the way the main step exports them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPORTER = path.join(__dirname, '..', '..', 'reporter', 'reporter.js');
const { checkRun } = require('../../lib/check');
const { applyRun, emptyHistory, runSamples, serializeHistory } = require('../../lib/history');
const { fingerprint } = require('../../lib/identity');
const { sha256 } = require('../../lib/util');
const { FIXTURE } = require('./fixture');
const { checkAll, listIntended, runPartition } = require('../../harness/index.js');

const HARNESS_REPORTER = path.join(__dirname, '..', '..', 'harness', 'reporter.js');
const KEY = 'fixture-history-key';
const PLAYWRIGHT = require(
  path.join(FIXTURE, 'node_modules', '@playwright', 'test', 'package.json')
).version;

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Writes a history to a file and returns `{ file, sha, text }`. */
function writeSnapshot(history, dir = tempDir('psp-snapshot-')) {
  const text = serializeHistory(history);
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, text);
  return { file, sha: sha256(text), text };
}

/**
 * The partition of `total` shards in `mode`. `snapshot` is `{ file, sha }` for balanced mode, or
 * one per shard (an array) to give a shard other bytes. `env` adds to every shard's environment.
 */
function actionPartition({
  total,
  mode,
  snapshot = null,
  workers = 1,
  recordDir,
  runId = 101,
  attempt = 1,
  env = {},
  args = [],
}) {
  return Array.from({ length: total }, (_, i) => {
    const own = Array.isArray(snapshot) ? snapshot[i] : snapshot;
    return {
      args: [
        `--shard=${i + 1}/${total}`,
        ...args,
        `--add-reporter=${HARNESS_REPORTER},${REPORTER}`,
      ],
      env: {
        PSP_MODE: mode,
        PSP_WORKERS: String(workers),
        PSP_KEY: KEY,
        PSP_RECORD: path.join(recordDir, `record-${i + 1}.json`),
        PSP_RUN_ID: String(runId),
        PSP_RUN_ATTEMPT: String(attempt),
        PSP_COMMIT: 'c0ffee',
        ...(own ? { PSP_SNAPSHOT: own.file, PSP_SNAPSHOT_SHA: own.sha } : {}),
        ...env,
      },
    };
  });
}

function readRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

/** The plan the finish phase would check these records against. */
function planOf({ mode, total, sha = null, runId = 101 }) {
  return { mode, total, sha, runId, fingerprint: fingerprint(KEY, PLAYWRIGHT) };
}

/** The history a passing run publishes into `base`. */
function publish(records, { base = emptyHistory(KEY), runId = 101, date = '2026-10-16' } = {}) {
  return applyRun(base, {
    id: runId,
    attempt: 1,
    commit: 'c0ffee',
    fingerprint: fingerprint(KEY, PLAYWRIGHT),
    date,
    samples: runSamples(records),
  }).history;
}

/** The plan lines the reporter logged in the harness output of each shard. */
const planLines = (shards) =>
  shards.map((shard) =>
    (shard.output || '')
      .split('\n')
      .filter((line) => /\[playwright-smart-parallelization\] shard \d+\/\d+: balanced/.test(line))
  );

const planShaOf = (line) => /plan ([0-9a-f]{12})/.exec(line)[1];

/**
 * Lists the intended leaves, runs the partition shard by shard and checks it with the harness.
 * Returns `{ violations, shards, leaves }`; each shard has its `output`.
 */
function runQualified(options, partition) {
  const listing = listIntended({ cwd: FIXTURE, ...options });
  const shards = runPartition({ cwd: FIXTURE, ...options }, partition);
  return {
    violations: checkAll(listing.leaves, listing.dependencies, shards),
    shards,
    leaves: listing.leaves,
  };
}

module.exports = {
  REPORTER,
  runQualified,
  HARNESS_REPORTER,
  KEY,
  PLAYWRIGHT,
  actionPartition,
  checkRun,
  planLines,
  planOf,
  planShaOf,
  publish,
  readRecords,
  tempDir,
  writeSnapshot,
};
