'use strict';

/**
 * Collects the qualification evidence of `@nsxbet/playwright-orchestrator`: one row per check,
 * grouped under the eight compatibility proofs and two extra cases, plus balance, footprint and
 * network results.
 * A row is `{ id, proof, title, status, subject, evidence }`. `status` is `pass`, `fail` (a
 * reproduced failure) or `skipped`. `subject` is `engine`, `integration` for a row that measures
 * glue code around the engine, or `playwright` for a row that shows Playwright's own behavior.
 * Only engine rows decide a proof. `proof` is a number 1 to 8, or an extra case (`x1`, `x2`).
 */

const { playwrightVersion } = require('../../harness');
const { createContext } = require('./context');
const { engineInfo } = require('./engine');
const { damagedTiming, recomputePerShard, singleAssignment } = require('./scenarios/assignment');
const { balance } = require('./scenarios/balance');
const { exactlyOnce, filters } = require('./scenarios/coverage');
const { footprint } = require('./scenarios/footprint');
const {
  cancelledRun,
  damagedExisting,
  failedRun,
  racingPublish,
  shardArtifacts,
} = require('./scenarios/history');
const { networkRows } = require('./scenarios/network');
const { newTests } = require('./scenarios/new-tests');
const { reportProofs } = require('./scenarios/reports');
const { serialGroups } = require('./scenarios/serial');

const PROOFS = [
  { number: 1, title: 'Every selected leaf runs in exactly one shard' },
  { number: 2, title: 'Serial groups and setup or teardown dependencies keep their behavior' },
  { number: 3, title: 'Filters and project selection mean the same as before' },
  { number: 4, title: 'Every shard uses one assignment' },
  { number: 5, title: 'Corrupt or mismatched input cannot split shards' },
  { number: 6, title: 'Exit codes, retries, traces and reports stay valid' },
  { number: 7, title: 'A run with no history is complete, new tests are kept' },
  {
    number: 8,
    title: 'Failed or cancelled runs and a damaged history file never replace good history',
  },
];

/** Cases the proofs do not cover: each has rows, and a result like a proof. */
const EXTRAS = [
  { id: 'x1', title: 'One shard with a damaged timing file' },
  { id: 'x2', title: 'Two runs racing to publish history' },
];

/** The proof's result: `fail` when any engine row of that proof failed. */
function proofStatus(rows, number) {
  const own = rows.filter((row) => row.proof === number && (row.subject || 'engine') === 'engine');
  return own.some((row) => row.status === 'fail') ? 'fail' : 'pass';
}

/** `{ id, title, status }` for each extra case. */
function summarizeExtras(rows) {
  return EXTRAS.map((extra) => ({ ...extra, status: proofStatus(rows, extra.id) }));
}

/** `{ number, title, status }` for each proof. */
function summarizeProofs(rows) {
  return PROOFS.map((proof) => ({ ...proof, status: proofStatus(rows, proof.number) }));
}

/**
 * The scenarios of each group. Groups share no state, so each can run on its own runner; the
 * group that measures balance (`serial`) and the one that measures footprint (`privacy`) hold all
 * the runs of their measurement, so no other work competes with it.
 */
const GROUPS = {
  coverage: (ctx) => [...exactlyOnce(ctx), ...filters(ctx), ...newTests(ctx)],
  serial: (ctx) => serialGroups(ctx),
  assignment: (ctx) => [singleAssignment(ctx), ...damagedTiming(ctx), recomputePerShard(ctx)],
  history: (ctx) => [
    ...shardArtifacts(ctx),
    ...reportProofs(ctx),
    damagedExisting(ctx),
    failedRun(ctx),
    cancelledRun(ctx),
    racingPublish(ctx),
  ],
};

const GROUP_NAMES = [...Object.keys(GROUPS), 'privacy'];

async function collectEvidence({ log = () => {}, requireOsBlock = false, group = 'all' } = {}) {
  const names = group === 'all' ? GROUP_NAMES : [group];
  for (const name of names) {
    if (!GROUP_NAMES.includes(name)) throw new Error(`unknown group ${name}`);
  }
  const started = Date.now();
  const ctx = createContext({ log });
  try {
    const rows = [];
    for (const name of names) {
      if (name !== 'privacy') rows.push(...GROUPS[name](ctx));
    }
    if (names.includes('privacy')) rows.push(...(await networkRows(ctx, { requireOsBlock })));
    const info = engineInfo();
    return {
      generatedAt: new Date().toISOString(),
      group,
      versions: {
        engine: `${info.name}@${info.version}`,
        playwright: playwrightVersion(ctx.cwd),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      rows: rows.map((row) => ({ subject: 'engine', ...row })),
      proofs: summarizeProofs(rows),
      extras: summarizeExtras(rows),
      balance: names.includes('serial') ? balance(ctx) : null,
      footprint: names.includes('privacy') ? footprint(ctx) : null,
      durationMs: Date.now() - started,
    };
  } finally {
    if (!process.env.PSP_KEEP_TMP) ctx.dispose();
  }
}

/**
 * Joins the evidence of separate groups into one: rows are concatenated, balance and footprint
 * come from the group that measured them, and the proofs are rolled up again. Throws on a
 * repeated row, on different versions or when two groups hold the same measurement.
 */
function mergeEvidence(parts) {
  if (parts.length === 0) throw new Error('nothing to merge');
  const [first] = parts;
  const ids = new Set();
  for (const part of parts) {
    if (JSON.stringify(part.versions) !== JSON.stringify(first.versions)) {
      throw new Error('the parts were collected with different versions');
    }
    for (const row of part.rows) {
      if (ids.has(row.id)) throw new Error(`row ${row.id} appears in two parts`);
      ids.add(row.id);
    }
  }
  const only = (key) => {
    const found = parts.map((part) => part[key]).filter(Boolean);
    if (found.length > 1) throw new Error(`${key} appears in two parts`);
    return found[0] || null;
  };
  const rows = parts.flatMap((part) => part.rows);
  return {
    generatedAt: new Date().toISOString(),
    group: 'all',
    versions: first.versions,
    rows,
    proofs: summarizeProofs(rows),
    extras: summarizeExtras(rows),
    balance: only('balance'),
    footprint: only('footprint'),
    durationMs: Math.max(...parts.map((part) => part.durationMs)),
    legsMs: Object.fromEntries(parts.map((part) => [part.group, part.durationMs])),
  };
}

module.exports = {
  EXTRAS,
  GROUP_NAMES,
  PROOFS,
  collectEvidence,
  mergeEvidence,
  proofStatus,
  summarizeExtras,
  summarizeProofs,
};
