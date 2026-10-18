'use strict';

/**
 * The exactly-once proof over the run records of one sharded suite, run by the finish action.
 *
 * Every shard of the suite has one record (the latest attempt), every record is of this run, no
 * shard job that started in an attempt and left no record may hide behind an earlier record, the
 * shards ran in one mode with one fingerprint, the balanced shards share one plan sha and one
 * snapshot sha, every record saw one corpus (the full unsharded selection), no non-setup test ran
 * in two shards, the tests that ran are exactly the corpus, none was stopped before it ran, and
 * every shard passed. A test that skips on purpose (statically or at runtime) counts as run; a run
 * in which every test skipped fails.
 *
 * The shape of the check follows the `check` command of playwright-shard-balancer (Copyright (c)
 * 2026 Gary Parker, MIT License); the identity here is Playwright's own test id, which keeps the
 * project and the repeat index apart from the title, so a title that reads like a repeat cannot
 * collide with one.
 */

const { sha256 } = require('./util');

const RECORD_SCHEMA = 'playwright-smart-parallelization/record';
const RECORD_VERSION = 1;
const STATUS_SCHEMA = 'playwright-smart-parallelization/status';
const START_SCHEMA = 'playwright-smart-parallelization/start';

const names = (ids) =>
  ids.length > 10 ? `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more` : ids.join(', ');

/** Throws unless `data` has the shape of a run record. */
function validateRecord(data, source = 'a record') {
  const ok =
    data &&
    data.schema === RECORD_SCHEMA &&
    data.version === RECORD_VERSION &&
    data.run &&
    Number.isSafeInteger(data.run.id) &&
    Number.isSafeInteger(data.run.attempt) &&
    data.shard &&
    Number.isSafeInteger(data.shard.current) &&
    Number.isSafeInteger(data.shard.total) &&
    typeof data.mode === 'string' &&
    Array.isArray(data.tests) &&
    data.tests.every(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        typeof t.key === 'string' &&
        Number.isSafeInteger(t.repeat) &&
        typeof t.ran === 'boolean' &&
        typeof t.outcome === 'string'
    ) &&
    (data.corpus === null ||
      (Array.isArray(data.corpus) &&
        data.corpus.every((c) => Array.isArray(c) && typeof c[0] === 'string')));
  if (!ok) throw new Error(`${source} is not a run record of this Action`);
  return data;
}

/**
 * Throws unless `data` is the status a disabled shard leaves: no reporter ran, so it names only
 * the job, the history key and the run.
 */
function validateStatus(data, source = 'a status record') {
  const ok =
    data &&
    data.schema === STATUS_SCHEMA &&
    data.version === RECORD_VERSION &&
    data.mode === 'disabled' &&
    data.run &&
    Number.isSafeInteger(data.run.id) &&
    Number.isSafeInteger(data.run.attempt) &&
    typeof data.key === 'string' &&
    typeof data.job === 'string';
  if (!ok) throw new Error(`${source} is not a status record of this Action`);
  return data;
}

/**
 * Throws unless `data` is the start marker a shard job's main step uploads before the user's
 * Playwright step: its token, which the job's record carries, the job, the key and the run.
 */
function validateStart(data, source = 'a start marker') {
  const ok =
    data &&
    data.schema === START_SCHEMA &&
    data.version === RECORD_VERSION &&
    typeof data.token === 'string' &&
    data.token !== '' &&
    data.run &&
    Number.isSafeInteger(data.run.id) &&
    Number.isSafeInteger(data.run.attempt) &&
    typeof data.key === 'string' &&
    typeof data.job === 'string';
  if (!ok) throw new Error(`${source} is not a start marker of this Action`);
  return data;
}

/**
 * The start markers that no record answers: shard jobs that started and left no record, because
 * Playwright stopped before it loaded the reporter, the job was cancelled, or the upload failed.
 */
const unanswered = (starts, records) => {
  const answered = new Set(records.map((r) => r.start).filter(Boolean));
  // Tries of one upload share the token: one start each.
  const byToken = new Map(starts.map((s) => [s.token, s]));
  return [...byToken.values()].filter((s) => !answered.has(s.token));
};

/**
 * A shard job that started in attempt `a` and left no record is one of the shards with no record
 * of attempt `a`. A shard re-run after `a` has a newer record that stands for it; any other could
 * be that job, so its earlier record cannot stand. One problem per attempt with such shards.
 */
function unrecordedProblems(latest, total, unrecorded) {
  const problems = [];
  const byAttempt = new Map();
  for (const start of unrecorded) {
    byAttempt.set(start.run.attempt, (byAttempt.get(start.run.attempt) || 0) + 1);
  }
  const latestAttempt = new Map(latest.map((r) => [r.shard.current, r.run.attempt]));
  for (const [attempt, count] of [...byAttempt].sort((a, b) => a[0] - b[0])) {
    const open = [];
    for (let k = 1; k <= total; k++) {
      if ((latestAttempt.get(k) || 0) < attempt) open.push(k);
    }
    if (!open.length) continue;
    problems.push(
      `${count} shard job(s) of attempt ${attempt} left no record (Playwright stopped before it ` +
        `loaded the reporter, the job was cancelled, or the upload failed), so shard ` +
        `${open.join(', ')} cannot stand on a record of an earlier attempt; re-run the shard jobs`
    );
  }
  return problems;
}

/**
 * Keeps the latest attempt of every shard. Two records of one shard and one attempt are a
 * duplicate the check reports. Returns `{ latest, duplicates }`.
 */
function latestAttempts(records) {
  const byShard = new Map();
  const duplicates = [];
  for (const record of records) {
    const shard = record.shard.current;
    const known = byShard.get(shard);
    if (!known || record.run.attempt > known.run.attempt) byShard.set(shard, record);
    else if (record.run.attempt === known.run.attempt) duplicates.push(shard);
  }
  const latest = [...byShard.values()].sort((a, b) => a.shard.current - b.shard.current);
  return { latest, duplicates: [...new Set(duplicates)].sort((a, b) => a - b) };
}

const corpusSha = (corpus) =>
  sha256(
    corpus
      .map((entry) => entry[0])
      .sort()
      .join('\n')
  );

/** `what` differs between shards: one problem naming the shards of each value, or none. */
function agree(latest, what, valueOf, problems) {
  const by = new Map();
  for (const r of latest) {
    const value = String(valueOf(r));
    if (!by.has(value)) by.set(value, []);
    by.get(value).push(r.shard.current);
  }
  if (by.size > 1) {
    const detail = [...by].map(([v, s]) => `${v} (shards ${s.join(', ')})`).join(' and ');
    problems.push(`shards ran with different ${what}: ${detail}`);
  }
}

/**
 * Checks the records of one suite. `expected` is `{ total, runId, unrecorded }`, where
 * `unrecorded` are the start markers of the suite's job that no record answers. Returns `{ ok,
 * exactlyOnceOk, passed, problems, records }`, where `records` are the latest attempts and `problems`
 * name every finding.
 */
function checkRun(expected, records) {
  const problems = [];
  const plan = expected;
  const { latest, duplicates } = latestAttempts(records);
  if (records.length === 0) problems.push('no run records: no shard wrote one');
  for (const shard of duplicates) {
    problems.push(`shard ${shard} has more than one record of the same attempt`);
  }
  const shards = new Set(latest.map((r) => r.shard.current));
  const missing = [];
  for (let k = 1; k <= plan.total; k++) if (!shards.has(k)) missing.push(k);
  if (missing.length) problems.push(`no record for shard ${missing.join(', ')}`);
  problems.push(...unrecordedProblems(latest, plan.total, plan.unrecorded || []));
  const outside = latest.filter((r) => r.shard.current > plan.total || r.shard.current < 1);
  if (outside.length) {
    problems.push(
      `records for shards outside 1..${plan.total}: ${outside.map((r) => r.shard.current).join(', ')}`
    );
  }
  for (const r of latest) {
    const at = `shard ${r.shard.current}`;
    if (r.shard.total !== plan.total) {
      problems.push(`${at} ran as one of ${r.shard.total} shards, the suite has ${plan.total}`);
    }
    if (r.run.id !== plan.runId)
      problems.push(`${at} is a record of run ${r.run.id}, not ${plan.runId}`);
    if (r.mode === 'balanced' && !r.planSha) problems.push(`${at} logged no plan`);
    if (!r.corpus) problems.push(`${at} recorded no corpus, so its selection cannot be proven`);
  }
  agree(latest, 'modes', (r) => r.mode, problems);
  agree(latest, 'fingerprints', (r) => r.fingerprint, problems);
  agree(
    latest.filter((r) => r.mode === 'balanced'),
    'snapshots',
    (r) => r.snapshotSha,
    problems
  );
  const planShas = new Set(latest.filter((r) => r.planSha).map((r) => r.planSha));
  if (planShas.size > 1)
    problems.push(`shards planned differently: plans ${[...planShas].join(', ')}`);
  const corpora = new Map();
  for (const r of latest.filter((x) => x.corpus)) {
    const sha = corpusSha(r.corpus);
    if (!corpora.has(sha)) corpora.set(sha, []);
    corpora.get(sha).push(r.shard.current);
  }
  if (corpora.size > 1) {
    const detail = [...corpora.values()].map((s) => `shards ${s.join(', ')}`).join(' and ');
    problems.push(`shards saw different test sets before the split: ${detail}`);
  }

  const labels = new Map();
  for (const r of latest) for (const [id, label] of r.corpus || []) labels.set(id, label || id);
  const label = (id) => labels.get(id) || id;
  const counts = new Map();
  for (const r of latest) {
    for (const t of r.tests) if (!t.setup) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  }
  const twice = [...counts]
    .filter(([, n]) => n > 1)
    .map(([id]) => label(id))
    .sort();
  if (twice.length)
    problems.push(`${twice.length} test(s) ran in more than one shard: ${names(twice)}`);
  if (corpora.size === 1) {
    const corpus = latest.find((r) => r.corpus).corpus.map((entry) => entry[0]);
    const listed = new Set(corpus);
    const absent = corpus
      .filter((id) => !counts.has(id))
      .map(label)
      .sort();
    const extra = [...counts.keys()]
      .filter((id) => !listed.has(id))
      .map(label)
      .sort();
    if (absent.length) problems.push(`${absent.length} test(s) ran in no shard: ${names(absent)}`);
    if (extra.length)
      problems.push(`${extra.length} test(s) ran outside the corpus: ${names(extra)}`);
  }
  const notRun = latest
    .flatMap((r) => r.tests.filter((t) => !t.setup && !t.ran).map((t) => label(t.id)))
    .sort();
  if (notRun.length) {
    problems.push(
      `${notRun.length} test(s) did not run (interrupted, stopped at max failures, or a setup project failed): ${names(notRun)}`
    );
  }
  // Intentional skips are allowed; a run in which every test skipped proves nothing.
  const executed = latest.flatMap((r) => r.tests.filter((t) => !t.setup));
  if (executed.length && executed.every((t) => t.outcome === 'skipped')) {
    problems.push(`every one of the ${executed.length} tests skipped, so the run proves nothing`);
  }
  const exactlyOnceOk = problems.length === 0;
  const failed = latest.filter((r) => r.status !== 'passed');
  for (const r of failed) problems.push(`shard ${r.shard.current} ended with status ${r.status}`);
  const passed = failed.length === 0 && missing.length === 0 && latest.length > 0;
  return { ok: exactlyOnceOk && passed, exactlyOnceOk, passed, problems, records: latest };
}

module.exports = {
  RECORD_SCHEMA,
  RECORD_VERSION,
  START_SCHEMA,
  STATUS_SCHEMA,
  checkRun,
  corpusSha,
  latestAttempts,
  unanswered,
  validateRecord,
  validateStart,
  validateStatus,
};
