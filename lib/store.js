'use strict';

/**
 * Publishing the history by compare-and-swap on immutable cache keys, through a cache adapter
 * (lib/cache.js) over the official `@actions/cache` toolkit. Entries are
 * `psp-history-v2-<key>-<epoch>-<seq>` (lib/identity.js). A key is immutable, so a save onto a key
 * that exists changes nothing, and reading the key back is how a writer learns who won. Every
 * shard publishes its own samples, so as many writers as shards can race. One attempt:
 *
 * 1. restore the newest entry by prefix;
 * 2. `write`: merge it with every entry read so far, apply this shard, continue the epoch of the
 *    entry read (or the one the pin holds) with `seq = max(seen, attempted, pinned) + 1` in that
 *    epoch, or start a chain under today's UTC date, and write the candidate into the cache folder;
 * 3. save the candidate under `…-<seq>`;
 * 4. a save that created the entry wrote our bytes; one that did not clears the folder and
 *    restores that exact key;
 * 5. `verify`: our bytes, and the history is published. Other bytes: another writer owns the key,
 *    its entry joins the merge and the next attempt writes the key after it at once, with no read
 *    of the newest entry first: every entry holds the one before it, so the entry just read holds
 *    every entry below it. A miss: another writer holds the key and has not finished uploading,
 *    so after a pause the next attempt reads the newest entry again and retries that same key,
 *    and never skips it.
 *
 * A key is immutable and a save creates it only when no other writer reserved it, so a save that
 * created the key needs no read-back. Each lost attempt lets one other writer through, so
 * `attempts` writers racing at once all publish within `attempts` attempts; the caller sets it
 * from the shard count. After the last attempt the history is left as it was. On the default
 * branch, which reads and writes one cache scope, step 1 reads the newest key without its bytes
 * first when this writer already holds the bytes of some key, such as the entry the pin holds or
 * one it read back, and downloads only a key it does not hold. Another ref also reads the default
 * branch's scope, where the same key can hold other bytes, so there step 1 always downloads. A shard the history already holds changes no byte, so a
 * re-run publishes nothing. A prefix read that misses while the pin holds an entry means the cache
 * is unavailable, and nothing is published: a new chain starts only when the pin saw no history.
 * A damaged entry is reported and its seq counts as seen; this shard's merge is published over it,
 * so the next run reads a healthy history.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CACHE_PATH, HISTORY_FILE, cacheKey, cachePrefix, cacheSlot } = require('./identity');
const {
  applyRun,
  emptyHistory,
  historySha,
  mergeHistories,
  parseHistory,
  serializeHistory,
} = require('./history');
const { short, writeAtomic } = require('./util');

/** The fewest attempts a writer makes; `attemptsFor` adds the shard count on top. */
const ATTEMPTS = 8;

/** Attempts for a run of `total` shards: every shard can race every other one. */
const attemptsFor = (total) => Math.max(ATTEMPTS, total + 4);

/**
 * `pinned` is the `{ epoch, seq }` of the entry the pin holds, or null when it saw no history.
 * Slots read, attempted and pending are `{ epoch, seq }` too.
 */
function newState({ key, run, pinned = null, attempts = ATTEMPTS }) {
  return {
    key,
    attempts,
    run: { ...run, samples: [...run.samples] },
    pinned,
    epoch: null,
    merged: null,
    seen: [],
    attempted: [],
    pending: null,
    written: null,
    status: 'pending',
    errors: [],
    log: [],
  };
}

const runOf = (state) => ({ ...state.run, samples: new Map(state.run.samples) });
const keyOf = (state, slot) => cacheKey(state.key, slot.epoch, slot.seq);
const same = (a, b) => a.epoch === b.epoch && a.seq === b.seq;

const remember = (state, slot) => {
  if (!state.seen.some((known) => same(known, slot))) state.seen.push(slot);
};

/** Merges an entry into what this writer read. A damaged entry is recorded as an error instead. */
function absorb(state, slot, text) {
  const key = keyOf(state, slot);
  remember(state, slot);
  try {
    const history = parseHistory(text, { key: state.key, source: `the history entry ${key}` });
    state.merged = state.merged ? mergeHistories(state.merged, history) : history;
  } catch (error) {
    state.errors.push(`${error.message}; this run's history is published over it`);
    state.log.push(`${key} is damaged: ${error.message}`);
  }
}

/** The epoch of a chain started on `date` (YYYY-MM-DD): YYYYMMDD. */
const dateEpoch = (date) => Number(String(date).replace(/-/g, ''));

/**
 * The slot this attempt writes: a pending key again, or the next seq of the chain. The chain is
 * the epoch of the entry last read, else the one the pin holds, else a new one under the UTC date
 * of this write: cold writers of one day meet on its first key, and no key of an older day holds it.
 */
function nextSlot(state) {
  if (state.epoch === null)
    state.epoch = state.pinned ? state.pinned.epoch : dateEpoch(state.run.date);
  const epoch = state.epoch;
  if (state.pending && state.pending.epoch === epoch) return state.pending;
  const seqs = [...state.seen, ...state.attempted, ...(state.pinned ? [state.pinned] : [])]
    .filter((slot) => slot.epoch === epoch)
    .map((slot) => slot.seq);
  return { epoch, seq: Math.max(0, ...seqs) + 1 };
}

/**
 * Step 2. `read` is `{ matchedKey, text }`, what the prefix restore returned (empty and null on a
 * miss), or null when this attempt follows a read-back of another writer's entry and read nothing
 * new. Returns `{ save, key, text }`; `save` is false when there is nothing to publish.
 */
function write(state, read) {
  const { matchedKey, text } = read || { matchedKey: '', text: null };
  if (matchedKey) {
    const slot = cacheSlot(state.key, matchedKey);
    if (slot === null) {
      throw new Error(`the cache returned ${matchedKey}, which is outside this history`);
    }
    state.epoch = slot.epoch;
    absorb(state, slot, text === null ? '' : text);
    // A pending key read as the newest entry finished uploading: its entry joined the merge.
    if (state.pending && same(state.pending, slot)) state.pending = null;
  } else if (read && state.pinned !== null && state.seen.length === 0) {
    state.status = 'unavailable';
    state.log.push(
      `the cache returned no history although the pin holds ${keyOf(state, state.pinned)}; nothing is published`
    );
    return { save: false, key: '', text: null };
  }
  const base = state.merged || emptyHistory(state.key);
  const { applied, history } = applyRun(base, runOf(state));
  if (!applied) {
    state.status = 'already';
    state.log.push(
      `the history already holds these samples of run ${state.run.id}; nothing to publish`
    );
    return { save: false, key: '', text: null };
  }
  const slot = nextSlot(state);
  state.attempted.push(slot);
  const candidate = serializeHistory(history);
  state.written = { ...slot, sha: historySha(candidate) };
  state.log.push(
    `attempt ${state.attempted.length}: saving ${keyOf(state, slot)} (${short(state.written.sha)})`
  );
  return { save: true, key: keyOf(state, slot), text: candidate };
}

/**
 * Step 5. `text` is what the exact restore of the written key returned, null on a miss. Returns
 * `{ retry }`: false once the history is published or the attempts are spent.
 */
function verify(state, { text }) {
  const slot = { epoch: state.written.epoch, seq: state.written.seq };
  const key = keyOf(state, slot);
  if (text !== null && historySha(text) === state.written.sha) {
    state.status = 'published';
    state.pending = null;
    state.log.push(`published ${key}`);
    return { retry: false };
  }
  if (text !== null) {
    state.pending = null;
    absorb(state, slot, text);
    state.log.push(`${key} belongs to another writer; its entry joins the merge`);
  } else {
    state.pending = slot;
    state.log.push(
      `${key} is not readable yet; another writer may still be saving it, so it is tried again`
    );
  }
  if (state.attempted.length >= state.attempts) {
    state.status = 'failed';
    state.log.push(`no key won after ${state.attempts} attempts; the history is unchanged`);
    return { retry: false };
  }
  return { retry: true };
}

// The loop around the steps, against a cache adapter (lib/cache.js).

const cacheDir = (workspace) => path.join(workspace, CACHE_PATH);

function readCacheFile(workspace) {
  const file = path.join(cacheDir(workspace), HISTORY_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function clearCache(workspace) {
  fs.rmSync(cacheDir(workspace), { recursive: true, force: true });
}

/** A pause of 200 to 1200 ms between attempts, so writers that lost together spread out. */
const jitter = () => 200 + Math.floor(Math.random() * 1000);

/** Restores `key` exactly into the cache folder: its text, or null on a miss. */
async function restoreExact(cache, workspace, key) {
  clearCache(workspace);
  const hit = (await cache.restore(CACHE_PATH, key)) === key;
  const text = hit ? readCacheFile(workspace) : null;
  clearCache(workspace);
  return text;
}

/**
 * Step 1: the newest entry by prefix, `{ matchedKey, text }`. `held` maps the keys whose bytes
 * this writer holds to their text, or is null; a newest key among them is not downloaded again.
 */
async function readNewest(cache, workspace, prefix, held) {
  if (held && held.size) {
    const matchedKey = await cache.lookup(CACHE_PATH, prefix, [prefix]);
    if (!matchedKey) return { matchedKey: '', text: null };
    if (held.has(matchedKey)) return { matchedKey, text: held.get(matchedKey) };
    const text = await restoreExact(cache, workspace, matchedKey);
    if (text !== null) return { matchedKey, text };
    // Gone between the two reads: read the newest again, the way a writer that holds none does.
  }
  clearCache(workspace);
  const matchedKey = (await cache.restore(CACHE_PATH, prefix, [prefix])) || '';
  const text = matchedKey ? readCacheFile(workspace) : null;
  clearCache(workspace);
  return { matchedKey, text };
}

/**
 * Runs the attempts of `state` against `cache` until the history is published, already holds the
 * shard, or the attempts are spent. `held` maps cache keys to the text this writer already holds
 * for them, such as the entry the pin holds, and the keys it reads back join it; null, off the
 * default branch, holds none. Returns `state`; any error ends it as `failed`.
 */
async function publish(state, { cache, workspace, sleep, pause = jitter, held = null }) {
  const prefix = cachePrefix(state.key);
  const bytes = held && new Map(held);
  try {
    let read = await readNewest(cache, workspace, prefix, bytes);
    for (;;) {
      const candidate = write(state, read);
      if (!candidate.save) return state;
      clearCache(workspace);
      writeAtomic(path.join(cacheDir(workspace), HISTORY_FILE), candidate.text);
      const created = await cache.save(CACHE_PATH, candidate.key);
      if (cache.writeDenied) {
        state.status = 'failed';
        state.log.push('the Actions cache refuses writes for this job; the history is unchanged');
        return state;
      }
      const back = created ? candidate.text : await restoreExact(cache, workspace, candidate.key);
      if (bytes && back !== null) bytes.set(candidate.key, back);
      if (!verify(state, { text: back }).retry) return state;
      if (back !== null) {
        // Another writer's entry, absorbed: the key after it is the next to try.
        read = null;
        continue;
      }
      await sleep(pause());
      read = await readNewest(cache, workspace, prefix, bytes);
    }
  } catch (error) {
    state.status = 'failed';
    state.log.push(`${error.message}; the history is unchanged`);
    return state;
  } finally {
    clearCache(workspace);
  }
}

module.exports = {
  ATTEMPTS,
  attemptsFor,
  clearCache,
  newState,
  publish,
  verify,
  write,
};
