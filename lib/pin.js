'use strict';

/**
 * One history snapshot pinned to a shard job of a workflow run, after playwright-shard-balancer's
 * restore action (Copyright (c) 2026 Gary Parker, MIT License): every shard of the job and every
 * re-run of one plans from the bytes the pin holds.
 *
 * The pin is the cache entry `psp-pin-v2-<key>-<job>-<run id>` (lib/identity.js). The Actions
 * cache is the one service of a run with a create-only write: of the saves of one key, exactly one
 * creates it and every other save changes nothing, however many jobs save it at once. The artifact
 * service has none: a name is unique within one job only, so shard jobs that upload one name at
 * once each create an artifact of it, and the ids that would tell them apart are not in the order
 * of creation. Both were measured on GitHub.
 *
 * Every shard restores the pin. A shard that misses it writes a candidate and saves it: the save
 * that creates the key decides, and every other shard reads the winner's bytes back, so the
 * shards whose saves lost plan from the winner's bytes, never from their own. A pin another shard
 * reserved and is still uploading is not readable yet, so a shard whose save lost looks again
 * after waits of 0.25, 0.25, 0.5, 1, 2, 4, 8 and 14 seconds, and then fails before any test: a
 * shard that planned from other bytes than the rest could run a test twice or not at all.
 *
 * The pin is `pin.json`: `{ schema, version, key, runId, job, matchedKey, history, note }`, where
 * `history` is the restored history text, or null when there was none, and `note` says why a pin
 * holds none on purpose, or is null. A pin is written even without a history, so a shard that
 * starts after another shard published still plans native like the rest. The candidate of a first
 * attempt is the newest history, which restores while the shard looks for the pin.
 *
 * Every shard also keeps the pin it planned from in its run record (lib/publish.js), since the
 * cache drops an entry unused for a week, or sooner under pressure, while a run can be re-run for
 * 30 days. The run's artifacts list while the shard looks for the pin, and a shard that finds no
 * pin takes its candidate from the records of the shards of this run that already ran, the newest
 * attempt of each: the bytes they planned from, or no history when they ran native. Shards that
 * planned from different bytes, or from bytes no record holds, cannot all be matched, so the shard
 * fails before any test. A re-run with no record either, because a re-run of the whole workflow
 * deletes the run's artifacts or the retention expired them, pins the newest history when the
 * repository keeps artifacts for the 30 days a run can be re-run, or the run is younger than the
 * retention (`runAge`, in days), since then no kept shard planned from a lost pin; otherwise the
 * shard cannot tell, so it fails too.
 *
 * A job that cannot both read and write the cache, by its cache mode, a runner without the cache
 * service, or a cache that refuses its writes, cannot pin a snapshot, so every shard of it runs
 * native: Playwright's own split, which needs no shared bytes. A shard that cannot pin while
 * shards of this run that already ran planned from a pin fails before any test instead.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRecord } = require('./check');
const { CACHE_PATH, HISTORY_FILE, PIN_FILE, PIN_PATH, cachePrefix, pinKey } = require('./identity');
const {
  artifactAttempt,
  artifactGone,
  canonicalJson,
  mapLimit,
  readJsonFile,
  sha256,
} = require('./util');

const SCHEMA = 'playwright-smart-parallelization/pin';
const WAITS = [0.25, 0.25, 0.5, 1, 2, 4, 8, 14];
/** The days a workflow run can be re-run. */
const RERUN_DAYS = 30;

const clear = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** The bytes of a pin: the same fields, in the same order, on every shard. */
const pinText = ({ key, runId, job, matchedKey, history, note = null }) =>
  canonicalJson({ schema: SCHEMA, version: 1, key, runId, job, matchedKey, history, note });

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
    (data.history === null || typeof data.history === 'string') &&
    (data.note === undefined || data.note === null || typeof data.note === 'string');
  if (!ok) throw new Error(`the pin ${name} is not a pin of this job and run`);
  return { matchedKey: data.matchedKey, history: data.history, note: data.note || null };
}

const unpinned = (reason) => ({ unpinned: true, reason });

/**
 * The records this job's shards uploaded in this run, from `listed` (the run's artifacts), the
 * newest attempt of each shard, as `{ record, pin }` with the pin it kept, or null.
 */
async function keptRecords(listed, artifacts, expected, attempt, dir) {
  const prefix = `psp-record-${expected.job}-${expected.key.slice(0, 12)}-`;
  const records = listed.filter((a) => a.name.startsWith(prefix) && /-attempt-\d+$/.test(a.name));
  const found = await mapLimit(records, 8, async (artifact) => {
    const target = path.join(dir, `record-${artifact.id}`);
    try {
      await artifacts.download(artifact.id, target);
    } catch (error) {
      // Deleted by a re-run of the whole workflow: the shard that left it is being re-run.
      if (artifactAttempt(artifact.name) < attempt && artifactGone(error)) return null;
      throw error;
    }
    let record;
    try {
      record = validateRecord(readJsonFile(path.join(target, 'record.json')));
    } catch {
      // Not a run record of this Action, such as a disabled shard's status: it planned nothing.
      return null;
    }
    if (record.key !== expected.key || record.run.id !== expected.runId) return null;
    let kept = null;
    try {
      kept = readPin(path.join(target, PIN_FILE), expected, artifact.name);
    } catch {
      // A record without its pin, as an older version of the Action left it.
    }
    return { record, pin: kept };
  });
  const newest = new Map();
  for (const entry of found.filter(Boolean)) {
    const { shard, run, corpusSha } = entry.record;
    const id = `${shard.current}/${shard.total}/${corpusSha || ''}`;
    const seen = newest.get(id);
    if (!seen || run.attempt > seen.record.run.attempt) newest.set(id, entry);
  }
  return [...newest.values()];
}

/**
 * What the shards of this run that already ran planned from, by their records: null when none
 * did, `{ native: true }`, or `{ pin }` with the bytes they planned from. Throws when they cannot
 * all be matched.
 */
function keptPlan(kept, name) {
  if (!kept.length) return null;
  const planOf = ({ record }) => (record.mode === 'balanced' ? record.snapshotSha : 'native');
  const plans = [...new Set(kept.map(planOf))];
  if (plans.length > 1) {
    throw new Error(
      `the pin ${name} is gone, and the shards of this run that already ran planned from ` +
        'different snapshots, so this shard cannot plan as all of them did; start a new run'
    );
  }
  if (plans[0] === 'native') return { native: true };
  const source = kept.find(
    ({ pin }) => pin && pin.history !== null && sha256(pin.history) === plans[0]
  );
  if (!source) {
    throw new Error(
      `the pin ${name} is gone, and no record of the shards that planned from it holds its ` +
        'bytes, so this shard cannot plan as they did; start a new run'
    );
  }
  return { pin: source.pin };
}

/**
 * The candidate of a shard that found no pin: the plan of the shards of this run that already
 * ran, else, for a re-run, nothing when no record can have expired, else null for the newest
 * history.
 */
async function candidateOf({ kept, name, attempt, retentionDays, runAge, log }) {
  const plan = keptPlan(kept, name);
  if (plan && plan.native) {
    log(`the pin ${name} is gone, and the shards of this run that already ran ran native`);
    return {
      matchedKey: '',
      history: null,
      note: 'the shards of this run that already ran ran native',
    };
  }
  if (plan) {
    log(
      `the pin ${name} is gone; this shard pins the bytes the shards that already ran planned from`
    );
    return plan.pin;
  }
  if (attempt === 1) return null;
  // Re-runs are allowed for 30 days. Artifacts kept that long, or a run younger than the
  // retention, prove that no record expired, so no kept shard planned from a lost pin.
  const retention = Number(retentionDays || 0);
  if (retention > 0 && retention < RERUN_DAYS) {
    const age = runAge ? await runAge() : null;
    if (age === null || age >= retention) {
      throw new Error(
        `the pin ${name} is not there, and with artifacts kept ${retention} days the records of ` +
          'the shards that planned from it may have expired, so this re-run cannot plan as they ' +
          'did; start a new run'
      );
    }
    log(`no record of this ${age.toFixed(1)}-day-old run holds a pin, so this re-run pins afresh`);
  }
  return null;
}

/**
 * The plan of a shard that cannot pin: native, unless shards of this run that already ran
 * planned from a pinned snapshot, which this shard cannot read without the cache.
 */
function cannotPin(kept, name, reason) {
  const plan = keptPlan(kept, name);
  if (plan && plan.pin) {
    throw new Error(
      `${reason}, and the shards of this run that already ran planned from the pin ${name}, so ` +
        'this shard cannot plan as they did; re-run it where the job can read and write the cache'
    );
  }
  return unpinned(`${reason}, so this shard runs native`);
}

/**
 * Returns `{ matchedKey, history, note }` from the pin, or `{ unpinned: true, reason }` when the
 * job cannot pin. Throws when the pin cannot be read, or this shard cannot plan as the others.
 */
async function pin({
  prepared,
  runId,
  attempt = 1,
  job,
  cache,
  artifacts,
  sleep,
  temp,
  retentionDays,
  runAge = null,
  log = () => {},
}) {
  const name = pinKey(prepared.key, job, runId);
  const expected = { key: prepared.key, runId, job };
  const dir = fs.mkdtempSync(path.join(temp || os.tmpdir(), 'psp-pin-'));
  // The run's artifacts list while the shard looks for the pin: a shard that finds none plans as
  // the shards that already ran, from the pins their records kept.
  const listing = (async () => {
    try {
      return await artifacts.list();
    } catch (error) {
      // A server with no artifact service keeps no records.
      if (error.name === 'GHESNotSupportedError') return [];
      throw error;
    }
  })();
  listing.catch(() => {});
  const kept = async () => keptRecords(await listing, artifacts, expected, attempt, dir);
  const pinDir = path.join(prepared.workspace, PIN_PATH);
  const readBack = async () => {
    clear(pinDir);
    try {
      if ((await cache.restore(PIN_PATH, name)) !== name) return null;
      return readPin(path.join(pinDir, PIN_FILE), expected, name);
    } finally {
      clear(pinDir);
    }
  };
  let restoring = null;
  try {
    if (!cache.available()) {
      return cannotPin(await kept(), name, 'the Actions cache is not available on this runner');
    }
    if (!cache.readable() || !cache.writable()) {
      return cannotPin(
        await kept(),
        name,
        "the job's cache mode does not let it read and write a pinned snapshot"
      );
    }
    // The newest history restores while the shard looks for the pin, so a shard that pins waits
    // for the slower of the two only.
    restoring = (async () => {
      const historyDir = path.join(prepared.workspace, CACHE_PATH);
      clear(historyDir);
      const prefix = cachePrefix(prepared.key);
      const matchedKey = (await cache.restore(CACHE_PATH, prefix, [prefix])) || '';
      const restored = path.join(historyDir, HISTORY_FILE);
      const history =
        matchedKey && fs.existsSync(restored) ? fs.readFileSync(restored, 'utf8') : null;
      clear(historyDir);
      return { matchedKey, history, note: null };
    })();
    // A shard that reads the pin never needs the restore; it only waits for it to end.
    restoring.catch(() => {});
    const found = await readBack();
    if (found) {
      log(`read the pin ${name}`);
      return found;
    }
    const shards = await kept();
    const candidate =
      (await candidateOf({ kept: shards, name, attempt, retentionDays, runAge, log })) ||
      (await restoring);
    clear(pinDir);
    fs.mkdirSync(pinDir, { recursive: true });
    fs.writeFileSync(path.join(pinDir, PIN_FILE), pinText({ ...expected, ...candidate }));
    let created;
    try {
      created = await cache.save(PIN_PATH, name);
    } finally {
      clear(pinDir);
    }
    if (created) {
      log(`pinned ${candidate.matchedKey || 'no history'} as ${name}`);
      return {
        matchedKey: candidate.matchedKey,
        history: candidate.history,
        note: candidate.note || null,
      };
    }
    if (cache.writeDenied) {
      // The cache refuses this job's writes, and so every shard's of it.
      const theirs = await readBack();
      if (theirs) return theirs;
      return cannotPin(shards, name, 'the Actions cache refuses writes for this job');
    }
    log(
      cache.saveFailed
        ? `the pin ${name} could not be saved; this shard plans from another shard's pin of it`
        : `another shard pinned ${name} first; this shard plans from its bytes`
    );
    for (const wait of [0, ...WAITS]) {
      if (wait) {
        log(
          `the pin ${name} is not readable yet; another shard may still be uploading it, so wait ${wait}s`
        );
        await sleep(wait * 1000);
      }
      const read = await readBack();
      if (read) return read;
    }
    throw new Error(
      `the pin ${name} was not readable after ${WAITS.reduce((a, b) => a + b, 0)}s, and this ` +
        'shard could not create it; this shard cannot plan from the same snapshot as the others, ' +
        'so it stops before any test'
    );
  } finally {
    await Promise.allSettled([restoring, listing]);
    clear(dir);
  }
}

module.exports = { RERUN_DAYS, SCHEMA, WAITS, pin, pinText, readPin };
