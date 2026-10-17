'use strict';

/**
 * One history snapshot pinned to a shard job of a workflow run, after playwright-shard-balancer's
 * restore action (Copyright (c) 2026 Gary Parker, MIT License): every shard restores the pin by
 * its exact key; the first shard to miss it restores the newest history, writes the pin and saves
 * it, and every shard then reads the pin back and plans from the bytes it holds, its own or the
 * winner's. A re-run of a shard finds the same pin, so it makes the same plan.
 *
 * The pin is `pin.json`: `{ schema, version, key, runId, job, matchedKey, history }`, where
 * `history` is the restored history text, or null when there was none. A pin is written even
 * without a history, so a shard that starts after another shard published still plans native
 * like the rest.
 *
 * A read-back that misses means another shard reserved the key and is still uploading, so the
 * shard tries again after waits of 1, 2, 4, 8 and 15 seconds and then fails before any test: a
 * shard that planned from other bytes than the rest could run a test twice or not at all. A cache
 * that refuses this run's writes refuses them for every shard, so then every shard runs native.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CACHE_PATH, HISTORY_FILE, PIN_FILE, PIN_PATH, cachePrefix, pinKey } = require('./identity');
const { canonicalJson, readJsonFile, writeAtomic } = require('./util');

const SCHEMA = 'playwright-smart-parallelization/pin';
const WAITS = [1, 2, 4, 8, 15];

const clear = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function readPin(dir, expected, key) {
  let data;
  try {
    data = readJsonFile(path.join(dir, PIN_FILE));
  } catch (error) {
    throw new Error(`the pin ${key} has no readable ${PIN_FILE}: ${error.message}`, {
      cause: error,
    });
  }
  const ok =
    data &&
    data.schema === SCHEMA &&
    data.version === 1 &&
    data.key === expected.key &&
    data.runId === expected.runId &&
    data.job === expected.job &&
    typeof data.matchedKey === 'string' &&
    (data.history === null || typeof data.history === 'string');
  if (!ok) throw new Error(`the pin ${key} is not a pin of this job and run`);
  return { matchedKey: data.matchedKey, history: data.history };
}

/**
 * Returns `{ matchedKey, history }` from the pin, or `{ unpinned: true, reason }` when the cache
 * refuses writes. Throws when the pin cannot be read back.
 */
async function pin({ prepared, runId, job, cache, sleep, log = () => {} }) {
  const workspace = prepared.workspace;
  const key = pinKey(prepared.key, runId, job);
  const pinDir = path.join(workspace, PIN_PATH);
  const historyDir = path.join(workspace, CACHE_PATH);
  const expected = { key: prepared.key, runId, job };
  const restorePin = async () => {
    clear(pinDir);
    if ((await cache.restore(PIN_PATH, key)) !== key) return null;
    try {
      return readPin(pinDir, expected, key);
    } finally {
      clear(pinDir);
    }
  };

  const found = await restorePin();
  if (found) {
    log(`read the pin ${key}`);
    return found;
  }

  clear(historyDir);
  const prefix = cachePrefix(prepared.key);
  const matchedKey = (await cache.restore(CACHE_PATH, prefix, [prefix])) || '';
  const file = path.join(historyDir, HISTORY_FILE);
  const history = matchedKey && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  clear(historyDir);
  writeAtomic(
    path.join(pinDir, PIN_FILE),
    canonicalJson({
      schema: SCHEMA,
      version: 1,
      key: prepared.key,
      runId,
      job,
      matchedKey,
      history,
    })
  );
  const saved = await cache.save(PIN_PATH, key);
  clear(pinDir);
  if (!saved && cache.writeDenied) {
    return {
      unpinned: true,
      reason: 'the Actions cache refuses writes for this run, so no snapshot can be pinned',
    };
  }
  log(saved ? `pinned ${matchedKey || 'no history'} as ${key}` : `another shard pinned ${key}`);
  for (const wait of [0, ...WAITS]) {
    if (wait) {
      log(
        `the pin ${key} is not readable yet; another shard may still be saving it, so wait ${wait}s`
      );
      await sleep(wait * 1000);
    }
    const read = await restorePin();
    if (read) return read;
  }
  throw new Error(
    `the Actions cache did not return the pin ${key} after ${WAITS.reduce((a, b) => a + b, 0)}s, ` +
      'so this shard cannot plan from the same snapshot as the others; re-run the job, or set ' +
      'enabled: false where the cache cannot be written'
  );
}

module.exports = { SCHEMA, WAITS, pin, readPin };
