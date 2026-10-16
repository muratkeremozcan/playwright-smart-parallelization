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
const {
  EXTRAS,
  PROOFS,
  mergeEvidence,
  proofStatus,
  summarizeExtras,
  summarizeProofs,
} = require('../lib/evidence');

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
