'use strict';

/**
 * The main step of the Action, once per shard job, before the user's Playwright step. It decides
 * the mode of this shard and hands the user's command its arguments in `PSP_ARGS`:
 *
 * - `disabled` when the Playwright version is unknown or below 1.63, or the project uses Yarn
 *   Plug'n'Play: `PSP_ARGS` is empty, so the user's run is exactly native, nothing is pinned and
 *   nothing is published. Turning balancing off is an `if:` on the step, which skips it.
 * - `native` when the pinned snapshot holds no usable history (none yet, empty or damaged), or the
 *   job cannot read the cache or pin a snapshot: the Action's reporter records the run and Playwright keeps its own split.
 * - `balanced` when the pinned snapshot is a valid history: the reporter plans from its bytes,
 *   strictly, so a shard that cannot read them stops before any test.
 *
 * The snapshot is pinned to the workflow run (lib/pin.js), so every shard of the job and every
 * re-run of one plans from the same bytes, and every shard makes the same decision from them. The
 * pin also goes into the shard's run record, so a re-run can plan as the shards it keeps.
 *
 * A shard that is not disabled uploads a start marker with a token its record carries, so the
 * finish action can tell a re-run shard that left no record from a shard that was not re-run and
 * keeps its earlier record. The marker uploads while the shard reads its pin, and the step waits
 * for both before it ends either way, so a shard that fails here leaves its marker too. A shard
 * whose marker cannot be uploaded stops before any test.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RECORD_VERSION, START_SCHEMA } = require('./check');
const { MIN_PLAYWRIGHT, PIN_FILE, cacheSlot, startName } = require('./identity');
const { parseHistory } = require('./history');
const { ACTION_INPUTS, actionInputs, readInputs } = require('./inputs');
const { pin, pinText } = require('./pin');
const { findPlaywrightVersion } = require('./playwright-version');
const { compareVersions, sha256, short, writeAtomic } = require('./util');

/** The first `name` in `start` or a folder above it, up to `stop`, or null. */
function findUp(start, stop, name) {
  let dir = path.resolve(start);
  const end = path.resolve(stop);
  for (;;) {
    if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    const parent = path.dirname(dir);
    if (dir === end || parent === dir) return null;
    dir = parent;
  }
}

const SKIP = new Set(['node_modules', '.git', '.psp']);

/**
 * The Playwright versions of the projects under the workspace, three folders deep at most, for a
 * working directory with none of its own: `[{ dir, version }]`.
 */
function projectVersions(workspace, depth = 3) {
  const found = [];
  const visit = (dir, level) => {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const { version } = findPlaywrightVersion(dir, dir);
      if (version) found.push({ dir: path.relative(workspace, dir) || '.', version });
    }
    if (level === depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !SKIP.has(entry.name))
        visit(path.join(dir, entry.name), level + 1);
    }
  };
  visit(workspace, 0);
  return found;
}

/**
 * The Playwright version this shard runs, read before the user's step: from the working directory
 * up to the workspace, else the lowest of the projects under the workspace. Every shard reads the
 * same commit, so every shard finds the same version. Returns `{ version, where }`.
 */
function playwrightOf(prepared) {
  const start = path.join(prepared.workspace, prepared.workingDirectory);
  const own = findPlaywrightVersion(start, prepared.workspace);
  if (own.version) return { version: own.version, where: prepared.workingDirectory };
  const projects = projectVersions(prepared.workspace);
  if (!projects.length) return { version: null, where: null };
  const lowest = projects.reduce((a, b) => (compareVersions(b.version, a.version) < 0 ? b : a));
  return { version: lowest.version, where: lowest.dir };
}

/** `disabled` with a reason when this shard cannot balance at all, else null. */
function preliminary(prepared) {
  const start = path.join(prepared.workspace, prepared.workingDirectory);
  const pnp = findUp(start, prepared.workspace, '.pnp.cjs');
  if (pnp) {
    return {
      mode: 'disabled',
      reason: `Yarn Plug'n'Play (${path.relative(prepared.workspace, pnp) || '.pnp.cjs'}) has no node_modules for the reporter to load Playwright from`,
    };
  }
  const { version, where } = playwrightOf(prepared);
  if (!version) {
    return {
      mode: 'disabled',
      reason: `no Playwright version found in a lockfile or node_modules of the workspace; set working-directory to the Playwright project`,
    };
  }
  if (compareVersions(version, MIN_PLAYWRIGHT) < 0) {
    return {
      mode: 'disabled',
      reason: `Playwright ${version} in ${where} is below ${MIN_PLAYWRIGHT}, the first with --add-reporter and the preprocess hook`,
    };
  }
  return null;
}

/** The mode of this shard from the pinned snapshot: `{ mode, reason, text, sha, slot, tests }`. */
function decide(pinned, key) {
  const native = (reason, extra = {}) => ({ mode: 'native', reason, text: null, ...extra });
  if (pinned.unpinned) return native(pinned.reason, { slot: null });
  const slot = cacheSlot(key, pinned.matchedKey);
  if (!pinned.matchedKey) return native(pinned.note || 'no history yet', { slot: null });
  if (!slot) {
    return native(
      `the cache returned ${pinned.matchedKey}, which is not a history entry of this key`,
      {
        slot: null,
      }
    );
  }
  if (pinned.history === null) {
    return native(`the history entry ${pinned.matchedKey} has no readable file`, { slot });
  }
  let history;
  try {
    history = parseHistory(pinned.history, {
      key,
      source: `the history entry ${pinned.matchedKey}`,
    });
  } catch (error) {
    return native(error.message, { slot, damaged: true });
  }
  const tests = Object.keys(history.tests).length;
  if (tests === 0) return native(`the history entry ${pinned.matchedKey} has no entries`, { slot });
  if (!history.source) {
    return native(`the history entry ${pinned.matchedKey} names no run to take workers from`, {
      slot,
    });
  }
  return {
    mode: 'balanced',
    reason: `history entry ${pinned.matchedKey}`,
    text: pinned.history,
    sha: sha256(pinned.history),
    slot,
    tests,
  };
}

/** The age of this workflow run in days, from the runs API, or null when it cannot be read. */
async function runAgeDays(env, fetchImpl, token) {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  if (!token || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID || typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(
      `${api}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } }
    );
    if (!response.ok) return null;
    const created = Date.parse((await response.json()).created_at);
    return Number.isFinite(created) ? (Date.now() - created) / 86400000 : null;
  } catch {
    return null;
  }
}

/**
 * The reporter path for `PSP_ARGS`: a copy of the bundled reporter in a `node_modules` folder under
 * the job's temp folder. Playwright compiles a reporter outside `node_modules` with Babel before
 * it loads it, which costs the user's step about half a second on a hosted runner for this bundle,
 * and loads one inside `node_modules` as it is. The user's shell splits `PSP_ARGS` at whitespace,
 * so the copy goes under the first of the job's temp folder and the system temp folder whose path
 * has none.
 */
function reporterPath(bundled, temp) {
  const dir = `psp-reporter-${sha256(bundled).slice(0, 12)}`;
  const tried = [];
  for (const root of [temp, os.tmpdir()].filter(Boolean)) {
    const copy = path.join(
      root,
      dir,
      'node_modules',
      'playwright-smart-parallelization',
      'reporter.js'
    );
    if (/\s/.test(copy)) {
      tried.push(copy);
      continue;
    }
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(bundled, copy);
    return copy;
  }
  throw new Error(
    `the reporter copies ${tried.join(' and ')} have whitespace in their paths, which $PSP_ARGS cannot carry`
  );
}

/** The key of the start marker of a shard whose inputs are invalid, so it has no history key. */
const INVALID_KEY = 'invalid-inputs';

/** The waits in seconds between the tries of a start marker upload. */
const START_WAITS = [1, 2, 4];

/**
 * Uploads the start marker of this shard job and returns its token, or null when the run has no
 * artifact service (an old GHES). An upload that still fails after the waits of `START_WAITS`
 * stops the shard before any test, so its job is red: without the marker, a re-run of this shard
 * that leaves no record could not be told from a shard that was not re-run.
 */
async function markStart(base, { artifacts, io, temp, sleep }) {
  // One token for every try, so a try whose upload landed though it reported a failure stands for
  // the same start; each try has a name of its own, since a failed try may have created its name.
  const token = crypto.randomBytes(6).toString('hex');
  let last = null;
  for (const [index, wait] of [0, ...START_WAITS].entries()) {
    if (wait) await sleep(wait * 1000);
    const dir = fs.mkdtempSync(path.join(temp || os.tmpdir(), 'psp-start-'));
    const file = path.join(dir, 'start.json');
    writeAtomic(
      file,
      `${JSON.stringify({
        schema: START_SCHEMA,
        version: RECORD_VERSION,
        token,
        run: { id: base.runId, attempt: base.attempt },
        key: base.key,
        job: base.job,
        historyKey: base.historyKey,
      })}\n`
    );
    const name = startName(base.key, base.job, token, base.attempt, index + 1);
    try {
      await artifacts.upload(name, [file], dir);
      io.info(`uploaded ${name}`);
      return token;
    } catch (error) {
      if (error.name === 'GHESNotSupportedError') return null;
      last = error;
      io.info(`the start marker ${name} was not uploaded: ${error.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(
    `the start of this shard could not be uploaded: ${last.message}; without it the finish ` +
      'action cannot tell a re-run of this shard that leaves no record, so the shard stops ' +
      'before any test',
    { cause: last }
  );
}

/**
 * The main step. `io` is the step's output side, `cache` an adapter of lib/cache.js, `artifacts`
 * one of the run's artifacts (src/index.js), `reporter` the path of the bundled reporter. Returns the state the post step reads.
 */
async function setup({
  env = process.env,
  io,
  cache,
  artifacts,
  sleep,
  reporter,
  fetchImpl = globalThis.fetch,
}) {
  const token = readInputs(['github-token'], env)['github-token'];
  const runId = Number(env.GITHUB_RUN_ID || 0);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
  const job = env.GITHUB_JOB || 'job';
  const inputs = readInputs(ACTION_INPUTS, env);
  let prepared;
  try {
    prepared = actionInputs(inputs, env);
  } catch (error) {
    // A start marker still goes up, so finish sees a shard job that started and left no record,
    // and never takes the run for one whose Action step an if: skipped.
    const started = { key: INVALID_KEY, historyKey: inputs['history-key'], job, runId, attempt };
    await markStart(started, { artifacts, io, temp: env.RUNNER_TEMP, sleep }).catch(() => {});
    throw error;
  }
  const base = {
    key: prepared.key,
    historyKey: prepared.historyKey,
    publish: prepared.publish,
    job,
    runId,
    attempt,
    commit: env.GITHUB_SHA || '',
  };
  const pre = preliminary(prepared);
  if (pre) {
    io.exportVariable('PSP_ARGS', '');
    io.info(`disabled: ${pre.reason}; PSP_ARGS is empty, so the run is plain Playwright`);
    io.setOutput('mode', pre.mode);
    io.setOutput('reason', pre.reason);
    io.setOutput('args', '');
    return { ...base, mode: 'disabled', reason: pre.reason };
  }

  const [marked, read] = await Promise.allSettled([
    markStart(base, { artifacts, io, temp: env.RUNNER_TEMP, sleep }),
    pin({
      prepared,
      runId,
      attempt,
      job,
      cache,
      artifacts,
      sleep,
      temp: env.RUNNER_TEMP,
      retentionDays: env.GITHUB_RETENTION_DAYS,
      runAge: () => runAgeDays(env, fetchImpl, token),
      log: io.info,
    }),
  ]);
  if (marked.status === 'rejected') throw marked.reason;
  if (read.status === 'rejected') throw read.reason;
  const start = marked.value;
  const pinned = read.value;
  const decided = decide(pinned, prepared.key);
  if (decided.damaged)
    io.warning(`history unusable, native sharding for this run: ${decided.reason}`);

  const dir = path.join(env.RUNNER_TEMP || os.tmpdir(), `psp-${prepared.key.slice(0, 12)}-${job}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const record = path.join(dir, 'record', 'record.json');
  // The pin goes up with the record, so a re-run after the cache evicted it plans the same.
  const kept = pinned.unpinned ? null : path.join(dir, 'record', PIN_FILE);
  if (kept) writeAtomic(kept, pinText({ key: prepared.key, runId, job, ...pinned }));
  const snapshot = path.join(dir, 'snapshot', 'history.json');
  if (decided.text) writeAtomic(snapshot, decided.text);
  const added = reporterPath(reporter, env.RUNNER_TEMP);
  // The workers stay the user's: Playwright resolves them from the config, the command and the
  // CPUs, and the reporter plans with the count the pinned history carries.
  const args = [`--add-reporter=${added}`];
  const exported = {
    PSP_ARGS: args.join(' '),
    PSP_REPORTER: added,
    PSP_MODE: decided.mode,
    PSP_REASON: decided.mode === 'native' ? decided.reason : '',
    PSP_KEY: prepared.key,
    PSP_HISTORY_KEY: prepared.historyKey,
    PSP_SNAPSHOT: decided.text ? snapshot : '',
    PSP_SNAPSHOT_SHA: decided.sha || '',
    PSP_RECORD: record,
    PSP_JOB: job,
    PSP_START: start || '',
    PSP_PINNED: pinned.unpinned ? 'false' : 'true',
    PSP_RUN_ID: String(runId || 1),
    PSP_RUN_ATTEMPT: String(attempt),
    PSP_COMMIT: base.commit,
    PSP_RUNNER_NAME: env.RUNNER_NAME || '',
  };
  for (const [name, value] of Object.entries(exported)) io.exportVariable(name, value);
  io.info(
    `mode ${decided.mode}: ${decided.reason}` +
      (decided.sha ? `, ${decided.tests} tests known, snapshot ${short(decided.sha)}` : '')
  );
  io.info(`PSP_ARGS=${exported.PSP_ARGS}`);
  io.setOutput('mode', decided.mode);
  io.setOutput('reason', decided.reason);
  io.setOutput('args', exported.PSP_ARGS);
  return {
    ...base,
    mode: decided.mode,
    reason: decided.reason,
    start,
    record,
    pin: kept,
    snapshot: decided.text ? snapshot : null,
    sha: decided.sha || null,
    slot: decided.slot ? { epoch: decided.slot.epoch, seq: decided.slot.seq } : null,
    // Publishing merges what the cache holds, so it needs a cache this job can read and write.
    cache: cache.available() && cache.readable() && cache.writable(),
  };
}

module.exports = {
  INVALID_KEY,
  decide,
  playwrightOf,
  preliminary,
  projectVersions,
  reporterPath,
  runAgeDays,
  START_WAITS,
  setup,
};
