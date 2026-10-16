'use strict';

/**
 * The prepare phase. It runs once, before the shard matrix, and decides the mode of the whole run:
 *
 * - `disabled` when `enabled` is false, or the Playwright version is unknown or below 1.63: every
 *   shard runs the plain command with `--shard`, no reporter is added and nothing is written.
 * - `native` when there is no usable history (none yet, empty or damaged): every shard runs
 *   Playwright's own split with the Action's reporter, so the run is checked and can publish the
 *   first history.
 * - `balanced` when the newest history entry is valid: its bytes become the run's snapshot,
 *   uploaded once as an artifact, and every shard verifies its sha before Playwright starts.
 *
 * `key` runs before the cache restore and says whether to restore; `plan` runs after it.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  CACHE_PATH,
  HISTORY_FILE,
  MIN_PLAYWRIGHT,
  artifactNames,
  cachePrefix,
  cacheSeq,
  fingerprint,
} = require('./identity');
const { parseHistory } = require('./history');
const { prepareInputs } = require('./inputs');
const { findPlaywrightVersion } = require('./playwright-version');
const { compareVersions, sha256, short, writeAtomic } = require('./util');

/** The mode of the run before any history is read: `disabled` with a reason, or null. */
function preliminary(prepared) {
  // The version is read in every mode: finish merges the blob reports with it.
  const found = findPlaywrightVersion(
    path.join(prepared.workspace, prepared.workingDirectory),
    prepared.workspace
  );
  if (!prepared.enabled) {
    return { mode: 'disabled', reason: 'the enabled input is false', playwright: found.version };
  }
  if (!found.version) {
    return {
      mode: 'disabled',
      reason: `no Playwright version found in a lockfile or node_modules from ${prepared.workingDirectory} up`,
      playwright: null,
    };
  }
  if (compareVersions(found.version, MIN_PLAYWRIGHT) < 0) {
    return {
      mode: 'disabled',
      reason: `Playwright ${found.version} is below ${MIN_PLAYWRIGHT}, the first with --add-reporter and the preprocess hook`,
      playwright: found.version,
    };
  }
  return { mode: null, reason: null, playwright: found.version };
}

function key({ inputs, env = process.env }) {
  const prepared = prepareInputs(inputs, env);
  const pre = preliminary(prepared);
  return {
    outputs: {
      restore: pre.mode === 'disabled' ? 'false' : 'true',
      prefix: cachePrefix(prepared.key),
      'cache-path': CACHE_PATH,
    },
    log: [`history key ${prepared.key}${pre.mode ? `, ${pre.mode}: ${pre.reason}` : ''}`],
  };
}

/** Reads the restored entry: `{ mode, reason, text }`. Removes the restored files. */
function readRestored(prepared, matchedKey) {
  const dir = path.join(prepared.workspace, CACHE_PATH);
  const file = path.join(dir, HISTORY_FILE);
  try {
    if (!matchedKey) return { mode: 'native', reason: 'no history yet', text: null };
    if (cacheSeq(prepared.key, matchedKey) === null) {
      return {
        mode: 'native',
        reason: `the cache returned ${matchedKey}, which is not a history entry of this key`,
        text: null,
      };
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return {
        mode: 'native',
        reason: `the history entry ${matchedKey} has no readable file: ${error.message}`,
        text: null,
      };
    }
    try {
      const history = parseHistory(text, {
        key: prepared.key,
        source: `the history entry ${matchedKey}`,
      });
      if (Object.keys(history.tests).length === 0) {
        return {
          mode: 'native',
          reason: `the history entry ${matchedKey} has no entries`,
          text: null,
        };
      }
      return {
        mode: 'balanced',
        reason: `history entry ${matchedKey}`,
        text,
        tests: Object.keys(history.tests).length,
      };
    } catch (error) {
      return { mode: 'native', reason: error.message, text: null, damaged: true };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function plan({ inputs, env = process.env }) {
  const prepared = prepareInputs(inputs, env);
  const pre = preliminary(prepared);
  const decided = pre.mode
    ? { mode: pre.mode, reason: pre.reason, text: null }
    : readRestored(prepared, env.PSP_MATCHED_KEY || '');
  const sha = decided.text ? sha256(decided.text) : null;
  const result = {
    v: 1,
    mode: decided.mode,
    reason: decided.reason,
    total: prepared.total,
    sha,
    key: prepared.key,
    command: prepared.command,
    workingDirectory: prepared.workingDirectory,
    workers: prepared.workers,
    runnerLabel: prepared.runnerLabel,
    historyKey: prepared.historyKey,
    playwright: pre.playwright,
    fingerprint: pre.playwright ? fingerprint(prepared.key, pre.playwright) : null,
    runId: Number(env.GITHUB_RUN_ID || 0),
    commit: env.GITHUB_SHA || '',
  };
  const outputs = {
    matrix: JSON.stringify({ shard: Array.from({ length: prepared.total }, (_, i) => i + 1) }),
    plan: JSON.stringify(result),
    mode: result.mode,
    artifact: '',
    'snapshot-dir': '',
  };
  const log = [
    `mode ${result.mode} for all ${result.total} shards: ${result.reason}` +
      (sha ? `, ${decided.tests} tests, snapshot ${short(sha)}` : ''),
  ];
  const annotations = [];
  if (decided.damaged)
    annotations.push(`history unusable, native sharding for this run: ${decided.reason}`);
  if (decided.text) {
    const dir = path.join(
      env.RUNNER_TEMP || require('node:os').tmpdir(),
      `psp-snapshot-${prepared.key.slice(0, 12)}`
    );
    fs.rmSync(dir, { recursive: true, force: true });
    writeAtomic(path.join(dir, HISTORY_FILE), decided.text);
    outputs.artifact = artifactNames(result).snapshot;
    outputs['snapshot-dir'] = dir;
  }
  const summary =
    `### Playwright Smart Parallelization: prepare\n\n` +
    `Mode **${result.mode}** for all ${result.total} shards: ${result.reason}.` +
    (sha ? ` Snapshot \`${short(sha)}\`, ${decided.tests} tests known.` : '') +
    '\n\n';
  return { outputs, log, annotations, summary, plan: result };
}

module.exports = { key, plan, preliminary, readRestored };
