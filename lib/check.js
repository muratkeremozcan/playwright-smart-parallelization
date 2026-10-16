'use strict';

/**
 * The exactly-once proof over the run records of one run, run by the finish phase before anything
 * is written to the history.
 *
 * Every shard of the plan has one record (the latest attempt), every record is of this run and
 * this plan's mode, the balanced shards share one plan sha and the snapshot sha of the plan, every
 * record saw one corpus (the full unsharded selection) and carries the plan's fingerprint, no
 * non-setup test ran in two shards, the tests that ran are exactly the corpus, none was stopped
 * before it ran, and every shard passed. A test that skips on purpose (statically or at runtime)
 * counts as run; a run in which every test skipped fails.
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

/** Throws unless `data` is the status record a disabled shard writes. */
function validateStatus(data, source = 'a status record') {
  const ok =
    data &&
    data.schema === STATUS_SCHEMA &&
    data.version === RECORD_VERSION &&
    data.run &&
    Number.isSafeInteger(data.run.id) &&
    Number.isSafeInteger(data.run.attempt) &&
    data.shard &&
    Number.isSafeInteger(data.shard.current) &&
    Number.isSafeInteger(data.shard.total) &&
    Number.isSafeInteger(data.exitCode);
  if (!ok) throw new Error(`${source} is not a status record of this Action`);
  return data;
}

/**
 * Records of the plan's attempt or later. A re-run of all jobs makes a new plan with a later
 * attempt, so a record of an earlier attempt cannot stand in for a shard that never ran again.
 */
const currentAttempts = (plan, records) =>
  records.filter((r) => r.run.attempt >= (plan.attempt || 1));

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

/**
 * Checks the records of one run against its plan. Returns `{ ok, coverageOk, passed, problems,
 * records }`, where `records` are the latest attempts and `problems` name every finding.
 */
function checkRun(plan, all) {
  const problems = [];
  const records = currentAttempts(plan, all);
  const { latest, duplicates } = latestAttempts(records);
  if (records.length === 0) problems.push('no run records: no shard wrote one');
  for (const shard of duplicates) {
    problems.push(`shard ${shard} has more than one record of the same attempt`);
  }
  const shards = new Set(latest.map((r) => r.shard.current));
  const missing = [];
  for (let k = 1; k <= plan.total; k++) if (!shards.has(k)) missing.push(k);
  if (missing.length) problems.push(`no record for shard ${missing.join(', ')}`);
  const outside = latest.filter((r) => r.shard.current > plan.total || r.shard.current < 1);
  if (outside.length) {
    problems.push(
      `records for shards outside 1..${plan.total}: ${outside.map((r) => r.shard.current).join(', ')}`
    );
  }
  for (const r of latest) {
    const at = `shard ${r.shard.current}`;
    if (r.shard.total !== plan.total) {
      problems.push(`${at} ran as one of ${r.shard.total} shards, the plan has ${plan.total}`);
    }
    if (r.run.id !== plan.runId)
      problems.push(`${at} is a record of run ${r.run.id}, not ${plan.runId}`);
    if (r.mode !== plan.mode)
      problems.push(`${at} ran in mode ${r.mode}, the plan says ${plan.mode}`);
    if (r.fingerprint !== plan.fingerprint) {
      problems.push(`${at} has fingerprint ${r.fingerprint}, the plan has ${plan.fingerprint}`);
    }
    if (plan.mode === 'balanced') {
      if (r.snapshotSha !== plan.sha) {
        problems.push(`${at} planned from snapshot ${r.snapshotSha}, the plan pinned ${plan.sha}`);
      }
      if (!r.planSha) problems.push(`${at} logged no plan`);
    }
    if (!r.corpus) problems.push(`${at} recorded no corpus, so its selection cannot be proven`);
  }
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
  const coverageOk = problems.length === 0;
  const failed = latest.filter((r) => r.status !== 'passed');
  for (const r of failed) problems.push(`shard ${r.shard.current} ended with status ${r.status}`);
  const passed = failed.length === 0 && missing.length === 0 && latest.length > 0;
  return { ok: coverageOk && passed, coverageOk, passed, problems, records: latest };
}

/**
 * The check of a disabled run: one status per shard, the latest attempt, each with exit code 0.
 * Without the reporter there is no coverage to prove, so finish stays a gate on the shards alone.
 */
function checkStatuses(plan, all) {
  const problems = [];
  const statuses = currentAttempts(plan, all).filter((s) => s.run.id === plan.runId);
  const { latest, duplicates } = latestAttempts(statuses);
  for (const shard of duplicates) {
    problems.push(`shard ${shard} has more than one status of the same attempt`);
  }
  const seen = new Set(latest.map((s) => s.shard.current));
  const missing = [];
  for (let k = 1; k <= plan.total; k++) if (!seen.has(k)) missing.push(k);
  if (missing.length) problems.push(`no status for shard ${missing.join(', ')}`);
  for (const s of latest) {
    if (s.exitCode !== 0) problems.push(`shard ${s.shard.current} exited with ${s.exitCode}`);
  }
  const ok = problems.length === 0;
  return { ok, coverageOk: ok, passed: ok, problems, records: [] };
}

module.exports = {
  RECORD_SCHEMA,
  RECORD_VERSION,
  STATUS_SCHEMA,
  checkRun,
  checkStatuses,
  corpusSha,
  latestAttempts,
  validateRecord,
  validateStatus,
};
