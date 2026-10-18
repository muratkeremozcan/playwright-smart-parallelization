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
/** The cache path of the pin, beside the history's, the same on every shard. */
const PIN_PATH = '.psp/pin';
const PIN_FILE = 'pin.json';

/**
 * The history key: one history per working directory and the user's `history-key`. Every shard of
 * a job must compute one key, so the pin is one, also when the shards run on runners of other
 * operating systems or architectures; the runner is therefore not part of it. The worker count is
 * not part of it either: the main step runs before Playwright resolves
 * it, and the history carries the count its last run resolved, which every shard plans with. The
 * config path, the environment and the Playwright version are not part of it either, so the user
 * separates those with `history-key`. The command is the user's own and runs after the Action, so
 * it is not part of the key: a test keeps its own samples under its project, file and titles,
 * whatever filter selected it.
 */
function historyKey({ workingDirectory, historyKey: extra }) {
  const identity = JSON.stringify({ v: 3, workingDirectory, historyKey: extra || '' });
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
 * The cache key that pins the snapshot of one shard job in its workflow run (lib/pin.js): every
 * shard of the job and every re-run of one reads it. The job id keeps two jobs of one run on
 * snapshots of their own, and the run id two runs, whatever commit they check out.
 */
const pinKey = (key, job, runId) => `psp-pin-v2-${key}-${job || 'job'}-${runId}`;

/** The name of one shard's record artifact, unique per job, suite, shard and attempt. */
function recordName(record) {
  const corpus = record.corpusSha ? record.corpusSha.slice(0, 12) : 'none';
  return (
    `psp-record-${record.job || 'job'}-${record.key.slice(0, 12)}-${corpus}-` +
    `${record.shard.current}of${record.shard.total}-attempt-${record.run.attempt}`
  );
}

/**
 * The name of the start marker a shard job's main step uploads before the user's Playwright step:
 * unique per job, key and attempt, per start by its token, which the job's record carries, and per
 * try of the upload.
 */
const startName = (key, job, token, attempt, tryIndex = 1) =>
  `psp-start-${job || 'job'}-${key.slice(0, 12)}-${token}-${tryIndex}-attempt-${attempt}`;

module.exports = {
  CACHE_PATH,
  HISTORY_FILE,
  MIN_PLAYWRIGHT,
  PIN_FILE,
  PIN_PATH,
  cacheKey,
  cachePrefix,
  cacheSlot,
  fingerprint,
  historyKey,
  pinKey,
  recordName,
  startName,
};
