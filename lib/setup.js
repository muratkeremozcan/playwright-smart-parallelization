'use strict';

/**
 * The main step of the Action, once per shard job, before the user's Playwright step. It decides
 * the mode of this shard and hands the user's command its arguments in `PSP_ARGS`:
 *
 * - `disabled` when `enabled` is false, the Playwright version is unknown or below 1.63, or the
 *   project uses Yarn Plug'n'Play: `PSP_ARGS` is empty, so the user's run is exactly native,
 *   nothing is pinned and nothing is published.
 * - `native` when the pinned snapshot holds no usable history (none yet, empty or damaged), or the
 *   job cannot read the cache or pin a snapshot: the Action's reporter records the run and Playwright keeps its own split.
 * - `balanced` when the pinned snapshot is a valid history: the reporter plans from its bytes,
 *   strictly, so a shard that cannot read them stops before any test.
 *
 * The snapshot is pinned to the workflow run (lib/pin.js), so every shard of the job and every
 * re-run of one plans from the same bytes, and every shard makes the same decision from them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MIN_PLAYWRIGHT, cacheSlot } = require('./identity');
const { parseHistory } = require('./history');
const { ACTION_INPUTS, actionInputs, readInputs } = require('./inputs');
const { pin } = require('./pin');
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
  if (!prepared.enabled) return { mode: 'disabled', reason: 'the enabled input is false' };
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
 * The reporter path for `PSP_ARGS`, which the user's shell splits at whitespace: the bundled file
 * itself, or a copy under the system temp folder when the Action's path has whitespace in it.
 */
function reporterPath(bundled) {
  if (!/\s/.test(bundled)) return bundled;
  const copy = path.join(os.tmpdir(), `psp-reporter-${sha256(bundled).slice(0, 12)}.js`);
  if (/\s/.test(copy)) {
    throw new Error(
      `the reporter path ${bundled} has whitespace in it, which $PSP_ARGS cannot carry, and so does ${copy}`
    );
  }
  fs.copyFileSync(bundled, copy);
  return copy;
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
  const prepared = actionInputs(readInputs(ACTION_INPUTS, env), env);
  const runId = Number(env.GITHUB_RUN_ID || 0);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
  const job = env.GITHUB_JOB || 'job';
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

  let unreadable = null;
  if (!cache.available()) unreadable = 'the Actions cache is not available on this runner';
  else if (!cache.readable()) unreadable = "the job's cache mode does not let it read the history";
  const pinned = await pin({
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
    unreadable,
    log: io.info,
  });
  const decided = decide(pinned, prepared.key);
  if (decided.damaged)
    io.warning(`history unusable, native sharding for this run: ${decided.reason}`);

  const dir = path.join(env.RUNNER_TEMP || os.tmpdir(), `psp-${prepared.key.slice(0, 12)}-${job}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const record = path.join(dir, 'record', 'record.json');
  const snapshot = path.join(dir, 'snapshot', 'history.json');
  if (decided.text) writeAtomic(snapshot, decided.text);
  const added = reporterPath(reporter);
  const args = [
    `--add-reporter=${added}`,
    ...(prepared.workers ? [`--workers=${prepared.workers}`] : []),
  ];
  const exported = {
    PSP_ARGS: args.join(' '),
    PSP_REPORTER: added,
    PSP_MODE: decided.mode,
    PSP_REASON: decided.mode === 'native' ? decided.reason : '',
    PSP_KEY: prepared.key,
    PSP_HISTORY_KEY: prepared.historyKey,
    PSP_WORKERS: String(prepared.workers || 1),
    PSP_SNAPSHOT: decided.text ? snapshot : '',
    PSP_SNAPSHOT_SHA: decided.sha || '',
    PSP_RECORD: record,
    PSP_JOB: job,
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
    record,
    sha: decided.sha || null,
    slot: decided.slot ? { epoch: decided.slot.epoch, seq: decided.slot.seq } : null,
    // Publishing merges what the cache holds, so it needs a cache this job can read and write.
    cache: cache.available() && cache.readable() && cache.writable(),
  };
}

module.exports = {
  decide,
  playwrightOf,
  preliminary,
  projectVersions,
  reporterPath,
  runAgeDays,
  setup,
};
