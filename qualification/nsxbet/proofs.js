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

async function collectEvidence({ log = () => {}, requireOsBlock = false } = {}) {
  const started = Date.now();
  const ctx = createContext({ log });
  try {
    return await collect(ctx, { started, requireOsBlock });
  } finally {
    if (!process.env.PSP_KEEP_TMP) ctx.dispose();
  }
}

async function collect(ctx, { started, requireOsBlock }) {
  const scenarios = [
    () => exactlyOnce(ctx),
    () => serialGroups(ctx),
    () => filters(ctx),
    () => [singleAssignment(ctx)],
    () => damagedTiming(ctx),
    () => [recomputePerShard(ctx)],
    () => shardArtifacts(ctx),
    () => reportProofs(ctx),
    () => newTests(ctx),
    () => [damagedExisting(ctx), failedRun(ctx), cancelledRun(ctx), racingPublish(ctx)],
  ];
  const rows = scenarios.flatMap((scenario) => scenario());
  rows.push(...(await networkRows(ctx, { requireOsBlock })));

  const info = engineInfo();
  return {
    generatedAt: new Date().toISOString(),
    versions: {
      engine: `${info.name}@${info.version}`,
      playwright: playwrightVersion(ctx.cwd),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    rows: rows.map((row) => ({ subject: 'engine', ...row })),
    proofs: summarizeProofs(rows),
    extras: summarizeExtras(rows),
    balance: balance(ctx),
    footprint: footprint(ctx),
    durationMs: Date.now() - started,
  };
}

module.exports = { EXTRAS, PROOFS, collectEvidence, proofStatus, summarizeExtras, summarizeProofs };
