'use strict';

/**
 * One history snapshot pinned to a shard job of a workflow run, after playwright-shard-balancer's
 * restore action (Copyright (c) 2026 Gary Parker, MIT License), with an artifact of the run in
 * place of its cache entry: every shard looks the pin up by name; the first shard to miss it
 * restores the newest history, writes the pin and uploads it, and every shard then downloads the
 * pin and plans from the bytes it holds, its own or the winner's. An artifact name is unique in a
 * workflow run, so a second upload of it fails and the first one stands. Artifacts outlive the
 * attempts of a run and the cache's eviction, so a re-run of a shard, days later or after the
 * history moved on, finds the same pin and makes the same plan.
 *
 * The pin is `pin.json`: `{ schema, version, key, runId, job, matchedKey, history }`, where
 * `history` is the restored history text, or null when there was none. A pin is written even
 * without a history, so a shard that starts after another shard published still plans native
 * like the rest.
 *
 * A re-run that finds no pin, because the run's artifacts expired, looks at the records the job's
 * shards left in earlier attempts: shards that planned from the lost pin cannot be matched, so the
 * shard fails before any test; shards that ran unpinned are matched by running unpinned too.
 *
 * A pin that is not found after a lost upload belongs to a shard still uploading it, so the shard
 * looks again after waits of 1, 2, 4, 8 and 15 seconds and then fails before any test: a shard
 * that planned from other bytes than the rest could run a test twice or not at all. A server with
 * no artifact service (an old GHES) has none for every shard, so then every shard runs native.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CACHE_PATH, HISTORY_FILE, PIN_FILE, cachePrefix, pinName } = require('./identity');
const { canonicalJson, readJsonFile, writeAtomic } = require('./util');

const SCHEMA = 'playwright-smart-parallelization/pin';
const WAITS = [1, 2, 4, 8, 15];

const clear = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function readPin(file, expected, name) {
  let data;
  try {
    data = readJsonFile(file);
  } catch (error) {
    throw new Error(`the pin ${name} has no readable ${PIN_FILE}: ${error.message}`, {
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
  if (!ok) throw new Error(`the pin ${name} is not a pin of this job and run`);
  return { matchedKey: data.matchedKey, history: data.history };
}

/**
 * Returns `{ matchedKey, history }` from the pin, or `{ unpinned: true, reason }` when the run has
 * no artifact service. Throws when the pin cannot be read.
 */
/** The run records this job's shards uploaded in earlier attempts of the run. */
async function earlierRecords(artifacts, key, job, dir) {
  const prefix = `psp-record-${job}-${key.slice(0, 12)}-`;
  const records = [];
  for (const artifact of (await artifacts.list()).filter((a) => a.name.startsWith(prefix))) {
    const target = path.join(dir, `record-${artifact.id}`);
    await artifacts.download(artifact.id, target);
    try {
      records.push(readJsonFile(path.join(target, 'record.json')));
    } catch {
      // Not a record of this Action; it says nothing about the pin.
    }
  }
  return records;
}

async function pin({
  prepared,
  runId,
  attempt = 1,
  job,
  cache,
  artifacts,
  sleep,
  temp,
  log = () => {},
}) {
  const name = pinName(prepared.key, job);
  const dir = fs.mkdtempSync(path.join(temp || os.tmpdir(), 'psp-pin-'));
  const expected = { key: prepared.key, runId, job };
  const find = async () => {
    const found = await artifacts.find(name);
    if (!found) return null;
    const target = path.join(dir, `download-${found.id}`);
    await artifacts.download(found.id, target);
    return readPin(path.join(target, PIN_FILE), expected, name);
  };
  try {
    let found;
    try {
      found = await find();
    } catch (error) {
      if (error.name === 'GHESNotSupportedError') {
        return {
          unpinned: true,
          reason: 'this server has no artifact service to pin a snapshot in',
        };
      }
      throw error;
    }
    if (found) {
      log(`read the pin ${name}`);
      return found;
    }
    if (attempt > 1) {
      // A re-run that finds no pin must plan as the shards it keeps did.
      const before = await earlierRecords(artifacts, prepared.key, job, dir);
      if (before.some((r) => r.pinned)) {
        throw new Error(
          `the pin ${name} is gone (expired with the run's artifacts), and shards of an earlier ` +
            'attempt planned from it, so this re-run cannot plan the same; start a new run'
        );
      }
      if (before.length) {
        return {
          unpinned: true,
          reason: 'the earlier attempt of this run ran unpinned, so this re-run does too',
        };
      }
    }

    const historyDir = path.join(prepared.workspace, CACHE_PATH);
    clear(historyDir);
    const prefix = cachePrefix(prepared.key);
    const matchedKey = (await cache.restore(CACHE_PATH, prefix, [prefix])) || '';
    const restored = path.join(historyDir, HISTORY_FILE);
    const history =
      matchedKey && fs.existsSync(restored) ? fs.readFileSync(restored, 'utf8') : null;
    clear(historyDir);
    const file = path.join(dir, 'upload', PIN_FILE);
    writeAtomic(
      file,
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
    let lost = null;
    try {
      await artifacts.upload(name, [file], path.dirname(file));
      log(`pinned ${matchedKey || 'no history'} as ${name}`);
    } catch (error) {
      lost = error;
      log(`another shard pinned ${name} first (${error.message})`);
    }
    for (const wait of [0, ...WAITS]) {
      if (wait) {
        log(
          `the pin ${name} is not readable yet; another shard may still be uploading it, so wait ${wait}s`
        );
        await sleep(wait * 1000);
      }
      const read = await find();
      if (read) return read;
    }
    throw new Error(
      `the pin ${name} was not found after ${WAITS.reduce((a, b) => a + b, 0)}s` +
        (lost ? `, and this shard could not upload it: ${lost.message}` : '') +
        '; this shard cannot plan from the same snapshot as the others, so it stops before any test'
    );
  } finally {
    clear(dir);
  }
}

module.exports = { SCHEMA, WAITS, pin, readPin };
