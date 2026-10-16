'use strict';

/**
 * Publishing the history by compare-and-swap on immutable cache keys, between the official
 * `actions/cache/restore` and `actions/cache/save` steps that `action.yml` unrolls into a fixed
 * number of attempts. Entries are `psp-history-v1-<key>-<seq>`. One attempt:
 *
 * 1. restore the newest entry by prefix (the step before `write`);
 * 2. `write`: merge it with every entry read so far, apply this run, choose
 *    `seq = max(seen, attempted) + 1` and write the candidate into the cache folder;
 * 3. save the candidate under `…-<seq>`; a key that exists already is left as it is;
 * 4. `clear` the folder and restore that exact key;
 * 5. `verify`: the restored bytes are ours, and the history is published. Other bytes mean another
 *    writer owns the key: its entry joins the merge and the next attempt moves past it. A miss
 *    means the other writer has not finished: the next attempt moves past that key as well.
 *
 * After the last attempt the history is left as it was and the finish phase fails. A run the
 * history already holds is not applied again, so a re-run of the finish job changes nothing.
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

function newState({ key, run }) {
  return {
    key,
    run: { ...run, samples: [...run.samples] },
    merged: null,
    seen: [],
    attempted: [],
    written: null,
    status: 'pending',
    log: [],
  };
}

const runOf = (state) => ({ ...state.run, samples: new Map(state.run.samples) });

function absorb(state, text, source) {
  const history = parseHistory(text, { key: state.key, source });
  state.merged = state.merged ? mergeHistories(state.merged, history) : history;
}

/**
 * Step 2. `matchedKey` and `text` are what the prefix restore returned (empty and null on a
 * miss). Returns `{ save, key, text }`; `save` is false when the history already holds the run.
 */
function write(state, { matchedKey, text }) {
  if (matchedKey) {
    const seq = cacheSeq(state.key, matchedKey);
    if (seq === null)
      throw new Error(`the cache returned ${matchedKey}, not an entry of this history`);
    if (text === null) throw new Error(`the history entry ${matchedKey} has no file`);
    if (!state.seen.includes(seq)) state.seen.push(seq);
    absorb(state, text, `the history entry ${matchedKey}`);
  }
  const base = state.merged || emptyHistory(state.key);
  const { applied, history } = applyRun(base, runOf(state));
  if (!applied) {
    state.status = 'already';
    state.log.push(`run ${state.run.id} is already in the history; nothing to publish`);
    return { save: false, key: '', text: null };
  }
  const seq = Math.max(0, ...state.seen, ...state.attempted) + 1;
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
    state.log.push(`published ${key}`);
    return { retry: false };
  }
  if (text !== null) {
    absorb(state, text, `the history entry ${key}`);
    if (!state.seen.includes(state.written.seq)) state.seen.push(state.written.seq);
    state.log.push(`${key} belongs to another writer; its entry joins the merge`);
  } else {
    state.log.push(`${key} is not readable yet; another writer may still be saving it`);
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
