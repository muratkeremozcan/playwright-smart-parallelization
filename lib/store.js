'use strict';

/**
 * Publishing the history by compare-and-swap on immutable cache keys, between the official
 * `actions/cache/restore` and `actions/cache/save` steps that `action.yml` unrolls into a fixed
 * number of attempts. Entries are `psp-history-v1-<key>-<seq>`. A key is immutable, so a save onto
 * a key that exists changes nothing, and reading the key back is how a writer learns who won.
 * One attempt:
 *
 * 1. restore the newest entry by prefix (the step before `write`);
 * 2. `write`: merge it with every entry read so far, apply this run, choose
 *    `seq = max(seen, attempted, pinned) + 1`, where `pinned` is the entry prepare pinned, and
 *    write the candidate into the cache folder;
 * 3. save the candidate under `…-<seq>`;
 * 4. `clear` the folder and restore that exact key;
 * 5. `verify`: our bytes, and the history is published. Other bytes: another writer owns the key,
 *    its entry joins the merge and the next attempt moves on. A miss: another writer holds the key
 *    and has not finished uploading, so the next attempt retries that same key and never skips it.
 *
 * After the last attempt the history is left as it was and the finish phase fails. A run the
 * history already holds is not applied again, so a re-run of the finish job changes nothing. A
 * prefix read that misses while prepare pinned an entry means the cache is unavailable, and nothing
 * is published: a new chain starts only when prepare saw no history. A damaged entry is reported as
 * an error and its seq counts as seen; this run's merge is published over it, so the job fails once
 * and the next run reads a healthy history.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CACHE_PATH, HISTORY_FILE, cacheKey, cacheSeq } = require('./identity');
const {
  applyRun,
  emptyHistory,
  historySha,
  mergeHistories,
  parseHistory,
  serializeHistory,
} = require('./history');
const { readJsonFile, short, writeAtomic } = require('./util');

const ATTEMPTS = 3;

/** `pinned` is the seq of the entry prepare read, or null when it saw no history. */
function newState({ key, run, pinned = null }) {
  return {
    key,
    run: { ...run, samples: [...run.samples] },
    pinned,
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

const remember = (state, seq) => {
  if (!state.seen.includes(seq)) state.seen.push(seq);
};

/** Merges an entry into what this writer read. A damaged entry is recorded as an error instead. */
function absorb(state, seq, text) {
  const key = cacheKey(state.key, seq);
  remember(state, seq);
  try {
    const history = parseHistory(text, { key: state.key, source: `the history entry ${key}` });
    state.merged = state.merged ? mergeHistories(state.merged, history) : history;
  } catch (error) {
    state.errors.push(`${error.message}; this run's history is published over it`);
    state.log.push(`${key} is damaged: ${error.message}`);
  }
}

/**
 * Step 2. `matchedKey` and `text` are what the prefix restore returned (empty and null on a
 * miss). Returns `{ save, key, text }`; `save` is false when there is nothing to publish.
 */
function write(state, { matchedKey, text }) {
  if (matchedKey) {
    const seq = cacheSeq(state.key, matchedKey);
    if (seq === null) {
      throw new Error(`the cache returned ${matchedKey}, which is outside this history`);
    }
    absorb(state, seq, text === null ? '' : text);
  } else if (state.pinned !== null && state.seen.length === 0) {
    state.status = 'unavailable';
    state.log.push(
      `the cache returned no history although prepare pinned ${cacheKey(state.key, state.pinned)}; nothing is published`
    );
    return { save: false, key: '', text: null };
  }
  const base = state.merged || emptyHistory(state.key);
  const { applied, history } = applyRun(base, runOf(state));
  if (!applied) {
    state.status = 'already';
    state.log.push(`run ${state.run.id} is already in the history; nothing to publish`);
    return { save: false, key: '', text: null };
  }
  const pinned = state.pinned === null ? [] : [state.pinned];
  const seq =
    state.pending === null
      ? Math.max(0, ...state.seen, ...state.attempted, ...pinned) + 1
      : state.pending;
  state.attempted.push(seq);
  const candidate = serializeHistory(history);
  state.written = { seq, sha: historySha(candidate) };
  state.log.push(
    `attempt ${state.attempted.length}: saving ${cacheKey(state.key, seq)} (${short(state.written.sha)})`
  );
  return { save: true, key: cacheKey(state.key, seq), text: candidate };
}

/**
 * Step 5. `text` is what the exact restore of the written key returned, null on a miss. Returns
 * `{ retry }`: false once the history is published or the attempts are spent.
 */
function verify(state, { text }) {
  const key = cacheKey(state.key, state.written.seq);
  if (text !== null && historySha(text) === state.written.sha) {
    state.status = 'published';
    state.pending = null;
    state.log.push(`published ${key}`);
    return { retry: false };
  }
  if (text !== null) {
    state.pending = null;
    absorb(state, state.written.seq, text);
    state.log.push(`${key} belongs to another writer; its entry joins the merge`);
  } else {
    state.pending = state.written.seq;
    state.log.push(
      `${key} is not readable yet; another writer may still be saving it, so it is tried again`
    );
  }
  if (state.attempted.length >= ATTEMPTS) {
    state.status = 'failed';
    state.log.push(`no key won after ${ATTEMPTS} attempts; the history is unchanged`);
    return { retry: false };
  }
  return { retry: true };
}

// I/O around the steps, for main.js.

const stateFile = (dir) => path.join(dir, 'store.json');
const cacheDir = (workspace) => path.join(workspace, CACHE_PATH);

function loadState(dir) {
  return readJsonFile(stateFile(dir));
}

function saveState(dir, state) {
  writeAtomic(stateFile(dir), `${JSON.stringify(state)}\n`);
}

function readCacheFile(workspace) {
  const file = path.join(cacheDir(workspace), HISTORY_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function clearCache(workspace) {
  fs.rmSync(cacheDir(workspace), { recursive: true, force: true });
}

function writeStep({ dir, workspace, matchedKey }) {
  const state = loadState(dir);
  try {
    const text = matchedKey ? readCacheFile(workspace) : null;
    clearCache(workspace);
    const result = write(state, { matchedKey, text });
    if (result.save) writeAtomic(path.join(cacheDir(workspace), HISTORY_FILE), result.text);
    return { save: result.save ? 'true' : 'false', key: result.key };
  } catch (error) {
    state.status = 'failed';
    state.log.push(`${error.message}; the history is unchanged`);
    throw error;
  } finally {
    saveState(dir, state);
  }
}

function verifyStep({ dir, workspace, hit }) {
  const state = loadState(dir);
  try {
    const text = hit ? readCacheFile(workspace) : null;
    clearCache(workspace);
    return { retry: verify(state, { text }).retry ? 'true' : 'false' };
  } catch (error) {
    state.status = 'failed';
    state.log.push(`${error.message}; the history is unchanged`);
    throw error;
  } finally {
    saveState(dir, state);
  }
}

module.exports = {
  ATTEMPTS,
  clearCache,
  loadState,
  newState,
  saveState,
  verify,
  verifyStep,
  write,
  writeStep,
};
