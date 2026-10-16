'use strict';

/**
 * Names derived from a run's inputs: the history key, the fingerprint, the cache key prefix and
 * the artifact names. Every phase computes them the same way, so they need no extra wiring.
 */

const { sha256 } = require('./util');

/** The lowest Playwright with `Reporter.preprocess` and `--add-reporter` (1.62 has no `--add-reporter`). */
const MIN_PLAYWRIGHT = '1.63.0';

/** The cache path of the history, relative to the workspace, the same in every phase. */
const CACHE_PATH = '.psp/history';
const HISTORY_FILE = 'history.json';

/**
 * The history key: one history per command, working directory, workers, runner label and the
 * user's `history-key`. Durations from another runner class or worker count are never mixed.
 */
function historyKey({ argv, workingDirectory, workers, runnerLabel, historyKey: extra }) {
  const identity = JSON.stringify({
    v: 1,
    command: argv,
    workingDirectory,
    workers: workers || null,
    runnerLabel,
    historyKey: extra || '',
  });
  return sha256(identity).slice(0, 24);
}

/** The fingerprint of a run: its history key and the Playwright version it runs. */
const fingerprint = (key, playwright) => sha256(JSON.stringify({ key, playwright })).slice(0, 24);

/**
 * History entries are `psp-history-v1-<key>-<epoch>-<seq>`. A writer that starts a chain uses its
 * own run id as the epoch; every other writer continues the epoch and seq of the entry it read.
 * A new chain therefore never collides with the keys of an old one, and a restore by the prefix
 * still returns the newest entry created, whatever its epoch.
 */
const cachePrefix = (key) => `psp-history-v1-${key}-`;
const cacheKey = (key, epoch, seq) => `${cachePrefix(key)}${epoch}-${seq}`;

/** The `{ epoch, seq }` of a cache key of this prefix, or null. */
function cacheSlot(key, matched) {
  if (!matched || !matched.startsWith(cachePrefix(key))) return null;
  const found = /^([1-9]\d*)-([1-9]\d*)$/.exec(matched.slice(cachePrefix(key).length));
  return found ? { epoch: Number(found[1]), seq: Number(found[2]) } : null;
}

const artifactNames = (plan) => {
  const base = `${plan.key.slice(0, 12)}-${plan.runId}`;
  return {
    snapshot: plan.sha ? `psp-snapshot-${base}-${plan.sha.slice(0, 12)}` : null,
    recordPrefix: `psp-record-${base}-`,
    record: (shard, attempt) => `psp-record-${base}-${shard}-attempt-${attempt}`,
    blobPrefix: `psp-blob-${base}-`,
    blob: (shard, attempt) => `psp-blob-${base}-${shard}-attempt-${attempt}`,
  };
};

module.exports = {
  CACHE_PATH,
  HISTORY_FILE,
  MIN_PLAYWRIGHT,
  artifactNames,
  cacheKey,
  cachePrefix,
  cacheSlot,
  fingerprint,
  historyKey,
};
