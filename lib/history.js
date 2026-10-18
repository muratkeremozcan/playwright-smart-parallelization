'use strict';

/**
 * The timing history: its schema, validation, merge and one deterministic byte form.
 *
 *   {
 *     schema: 'playwright-smart-parallelization/history', version: 2, key,
 *     source: { run, attempt, commit, fingerprint, date, workers } | null,
 *     runs: [run ids applied, ascending, the last 200],
 *     tests: { <test key>: { samples: [[runId, ms], ...], seen: 'YYYY-MM-DD' } }
 *   }
 *
 * `source` is the newest run applied, and `source.workers` the worker count its shard resolved:
 * every shard that plans from these bytes packs for that count, whatever count it resolves itself,
 * so shards on runners that resolve different counts still plan one split.
 *
 * A test key is `[project, spec file, ...titles]` as JSON. A test costs the median of its samples.
 * Samples are ordered by run id, and the window keeps the five with the highest run ids, so a
 * delayed older run merges in without displacing newer samples. A shard gives one sample per key:
 * the median of the passing attempts of every copy of that test in the shard, so a test under
 * `--repeat-each` gives one sample. Every shard publishes on its own, so a setup test that several
 * shards ran keeps the smallest of their samples for the run. A sample is never 0 ms.
 *
 * Merging is a union over entries: the same run gives the same samples wherever it is merged, so
 * merging every entry a writer read is safe and merging one twice changes nothing. The 5-sample
 * window and the 30-day expiry are taken from playwright-shard-balancer (Copyright (c) 2026 Gary
 * Parker, MIT License); the run-id ordering and the run-id dedupe are this Action's.
 */

const { canonicalJson, sha256 } = require('./util');
const { median } = require('./plan/estimate');

const SCHEMA = 'playwright-smart-parallelization/history';
const VERSION = 2;
const MAX_SAMPLES = 5;
const MAX_RUNS = 200;
const EXPIRE_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRunId = (value) => Number.isSafeInteger(value) && value > 0;
const isMs = (value) => Number.isSafeInteger(value) && value > 0;

function emptyHistory(key) {
  return { schema: SCHEMA, version: VERSION, key, source: null, runs: [], tests: {} };
}

function fail(source, message) {
  throw new Error(`${source} ${message}`);
}

/** Throws unless `data` is a valid history, for `key` when one is given. Returns `data`. */
function validateHistory(data, { key = null, source = 'the history' } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(source, 'is not an object');
  if (data.schema !== SCHEMA) fail(source, `has schema ${JSON.stringify(data.schema)}`);
  if (data.version !== VERSION)
    fail(source, `has unsupported version ${JSON.stringify(data.version)}`);
  if (typeof data.key !== 'string' || !data.key) fail(source, 'has no key');
  if (key !== null && data.key !== key) {
    fail(source, `belongs to history key ${data.key}, not ${key}`);
  }
  const allowed = ['key', 'runs', 'schema', 'source', 'tests', 'version'];
  const extra = Object.keys(data).filter((name) => !allowed.includes(name));
  if (extra.length) fail(source, `has unknown fields: ${extra.join(', ')}`);
  if (data.source !== null) {
    const s = data.source;
    const valid =
      s &&
      typeof s === 'object' &&
      isRunId(s.run) &&
      Number.isSafeInteger(s.attempt) &&
      s.attempt > 0 &&
      typeof s.commit === 'string' &&
      typeof s.fingerprint === 'string' &&
      typeof s.date === 'string' &&
      DATE.test(s.date) &&
      Number.isSafeInteger(s.workers) &&
      s.workers > 0 &&
      Object.keys(s).length === 6;
    if (!valid) fail(source, 'has an invalid source');
  }
  if (
    !Array.isArray(data.runs) ||
    data.runs.length > MAX_RUNS ||
    !data.runs.every((run, i) => isRunId(run) && (i === 0 || data.runs[i - 1] < run))
  ) {
    fail(source, 'has an invalid runs list');
  }
  if (!data.tests || typeof data.tests !== 'object' || Array.isArray(data.tests)) {
    fail(source, 'has no tests object');
  }
  for (const [testKey, entry] of Object.entries(data.tests)) {
    let parts;
    try {
      parts = JSON.parse(testKey);
    } catch {
      parts = null;
    }
    const keyOk =
      Array.isArray(parts) && parts.length >= 3 && parts.every((part) => typeof part === 'string');
    const samples = entry && entry.samples;
    const samplesOk =
      Array.isArray(samples) &&
      samples.length >= 1 &&
      samples.length <= MAX_SAMPLES &&
      samples.every(
        (sample, i) =>
          Array.isArray(sample) &&
          sample.length === 2 &&
          isRunId(sample[0]) &&
          isMs(sample[1]) &&
          (i === 0 || samples[i - 1][0] < sample[0])
      );
    const seenOk = entry && typeof entry.seen === 'string' && DATE.test(entry.seen);
    if (!keyOk || !samplesOk || !seenOk || Object.keys(entry).length !== 2) {
      fail(source, `has an invalid entry for ${testKey}`);
    }
  }
  return data;
}

/** The one byte form of a history: sorted keys, compact, a final newline. */
const serializeHistory = (history) => canonicalJson(history);

/**
 * Parses and validates history bytes. Bytes that are valid JSON but not the canonical form are
 * refused too, so every reader of one entry computes one sha from it.
 */
function parseHistory(text, { key = null, source = 'the history' } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`, { cause: error });
  }
  validateHistory(data, { key, source });
  if (serializeHistory(data) !== text) fail(source, 'is not in its canonical byte form');
  return data;
}

const historySha = (text) => sha256(text);

const laterSource = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if (a.run !== b.run) return a.run > b.run ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
};

/** The samples of one entry, unioned by run id, the highest five kept, ascending. */
function unionSamples(...lists) {
  const byRun = new Map();
  for (const list of lists) {
    for (const [run, ms] of list) {
      // The same run gives the same sample everywhere; on a conflict keep the smaller, so the
      // result does not depend on the order of the merge.
      if (!byRun.has(run) || ms < byRun.get(run)) byRun.set(run, ms);
    }
  }
  return [...byRun.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-MAX_SAMPLES)
    .map(([run, ms]) => [run, ms]);
}

const unionRuns = (...lists) => [...new Set(lists.flat())].sort((a, b) => a - b).slice(-MAX_RUNS);

/** The union of two histories of one key. Commutative, associative and idempotent. */
function mergeHistories(a, b) {
  if (a.key !== b.key) throw new Error(`cannot merge histories of keys ${a.key} and ${b.key}`);
  const tests = {};
  for (const testKey of new Set([...Object.keys(a.tests), ...Object.keys(b.tests)])) {
    const x = a.tests[testKey];
    const y = b.tests[testKey];
    tests[testKey] = {
      samples: unionSamples(x ? x.samples : [], y ? y.samples : []),
      seen: [x && x.seen, y && y.seen].filter(Boolean).sort().pop(),
    };
  }
  return {
    schema: SCHEMA,
    version: VERSION,
    key: a.key,
    source: laterSource(a.source, b.source),
    runs: unionRuns(a.runs, b.runs),
    tests,
  };
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

/**
 * One sample per test key of a run: the median of the passing-attempt durations of every copy of
 * that test in the records, with no 0 ms sample. `records` are run records of one run.
 */
function runSamples(records) {
  const byKey = new Map();
  for (const record of records) {
    for (const test of record.tests) {
      if (!isMs(test.sample_ms)) continue;
      if (!byKey.has(test.key)) byKey.set(test.key, []);
      byKey.get(test.key).push(test.sample_ms);
    }
  }
  const samples = new Map();
  for (const key of [...byKey.keys()].sort()) samples.set(key, median(byKey.get(key)));
  return samples;
}

/** Whether `runId` is older than every run the list can still hold, so it no longer applies. */
function hasRun(history, runId) {
  return history.runs.length >= MAX_RUNS && runId < history.runs[0];
}

/**
 * Applies the samples of one shard of a run to a history. `run` is `{ id, attempt, commit,
 * fingerprint, date, workers, samples }`, where `samples` maps a test key to ms. Every shard of a run
 * applies its own samples under the run's id, so a test has one sample per run whichever shard
 * ran it, and a re-run of a shard gives the smaller one. Entries the run did not sample are kept,
 * unless no run has seen them for more than 30 days. Returns `{ applied, history }`; a run older
 * than the runs list can hold, or one that changes no byte, is not applied.
 */
function applyRun(history, run) {
  if (hasRun(history, run.id)) return { applied: false, history };
  const tests = {};
  for (const [testKey, entry] of Object.entries(history.tests)) {
    if (run.samples.has(testKey) || daysBetween(entry.seen, run.date) <= EXPIRE_DAYS) {
      tests[testKey] = { samples: entry.samples.map((s) => [s[0], s[1]]), seen: entry.seen };
    }
  }
  for (const [testKey, ms] of run.samples) {
    const entry = tests[testKey];
    tests[testKey] = {
      samples: unionSamples(entry ? entry.samples : [], [[run.id, ms]]),
      seen: entry && entry.seen > run.date ? entry.seen : run.date,
    };
  }
  const source = {
    run: run.id,
    attempt: run.attempt,
    commit: run.commit,
    fingerprint: run.fingerprint,
    date: run.date,
    workers: run.workers,
  };
  const next = {
    schema: SCHEMA,
    version: VERSION,
    key: history.key,
    source: laterSource(history.source, source),
    runs: unionRuns(history.runs, [run.id]),
    tests,
  };
  if (serializeHistory(next) === serializeHistory(history)) return { applied: false, history };
  return { applied: true, history: next };
}

module.exports = {
  EXPIRE_DAYS,
  MAX_RUNS,
  MAX_SAMPLES,
  SCHEMA,
  VERSION,
  applyRun,
  emptyHistory,
  hasRun,
  historySha,
  mergeHistories,
  parseHistory,
  runSamples,
  serializeHistory,
  validateHistory,
};
