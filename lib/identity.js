'use strict';

/**
 * Names derived from a run's inputs: the history key, the fingerprint, the cache keys of the
 * history and of the pin, and the name of a shard's record artifact. Every shard computes them the
 * same way, so they need no extra wiring.
 */

const { sha256 } = require('./util');

/** The lowest Playwright with `Reporter.preprocess` and `--add-reporter` (1.62 has no `--add-reporter`). */
const MIN_PLAYWRIGHT = '1.63.0';

/** The cache path of the history, relative to the workspace, the same on every shard. */
const CACHE_PATH = '.psp/history';
const HISTORY_FILE = 'history.json';
const PIN_FILE = 'pin.json';

/**
 * The history key: one history per working directory, workers, runner label and the user's
 * `history-key`. Durations from another runner class or worker count are never mixed. The command
 * is the user's own and runs after the Action, so it is not part of the key: a test keeps its own
 * samples under its project, file and titles, whatever filter selected it.
 */
function historyKey({ workingDirectory, workers, runnerLabel, historyKey: extra }) {
  const identity = JSON.stringify({
    v: 2,
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
 * History entries are `psp-history-v2-<key>-<epoch>-<seq>`. A writer that starts a chain uses the
 * UTC date of its write (YYYYMMDD) as the epoch; every other writer continues the epoch and seq
 * of the entry it read. Cold writers of one day collide on the same first key and merge, a chain
 * started on a later day never collides with the keys of an old one, and a restore by the prefix
 * still returns the newest entry created, whatever its epoch.
 */
const cachePrefix = (key) => `psp-history-v2-${key}-`;
const cacheKey = (key, epoch, seq) => `${cachePrefix(key)}${epoch}-${seq}`;

/** The `{ epoch, seq }` of a cache key of this prefix, or null. */
function cacheSlot(key, matched) {
  if (!matched || !matched.startsWith(cachePrefix(key))) return null;
  const found = /^([1-9]\d*)-([1-9]\d*)$/.exec(matched.slice(cachePrefix(key).length));
  return found ? { epoch: Number(found[1]), seq: Number(found[2]) } : null;
}

/**
 * The artifact that pins the snapshot of one shard job in its workflow run: every shard of the
 * job and every re-run of one reads it. The job id keeps two jobs of one run on snapshots of their
 * own; an artifact belongs to its run, so the name needs no run id.
 */
const pinName = (key, job) => `psp-pin-${job || 'job'}-${key}`;

/** The name of one shard's record artifact, unique per job, suite, shard and attempt. */
function recordName(record) {
  const corpus = record.corpusSha ? record.corpusSha.slice(0, 12) : 'none';
  return (
    `psp-record-${record.job || 'job'}-${record.key.slice(0, 12)}-${corpus}-` +
    `${record.shard.current}of${record.shard.total}-attempt-${record.run.attempt}`
  );
}

module.exports = {
  CACHE_PATH,
  HISTORY_FILE,
  MIN_PLAYWRIGHT,
  PIN_FILE,
  cacheKey,
  cachePrefix,
  cacheSlot,
  fingerprint,
  historyKey,
  pinName,
  recordName,
};
