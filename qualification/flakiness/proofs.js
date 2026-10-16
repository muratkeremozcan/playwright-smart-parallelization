'use strict';

/**
 * Collects the qualification evidence of `@flakiness/playwright`: one row per check, grouped under
 * the eight compatibility proofs and two extra cases, plus balance, footprint and network
 * results. The row format and the roll-up are in `qualification/lib/evidence.js`.
 */

const { playwrightVersion } = require('../../harness');
const {
  EXTRAS,
  PROOFS,
  mergeEvidence,
  proofStatus,
  summarizeExtras,
  summarizeProofs,
} = require('../lib/evidence');
const { createContext } = require('./context');
const { engineInfo } = require('./engine');
const {
  damagedTiming,
  deterministicPlan,
  listMatchesRun,
  appliedByReporter,
  noGitRepository,
  splitShards,
} = require('./scenarios/assignment');
const { balance } = require('./scenarios/balance');
const { exactlyOnce, filters, newTests } = require('./scenarios/coverage');
const { footprint } = require('./scenarios/footprint');
const {
  cancelledRun,
  damagedInputs,
  failedRuns,
  fasterTest,
  racingPublish,
  shardReports,
  windowRebuild,
} = require('./scenarios/history');
const { networkRows } = require('./scenarios/network');
const { reportProofs } = require('./scenarios/reports');
const { serialGroups } = require('./scenarios/serial');

/**
 * The scenarios of each group. Groups share no state, so each can run on its own runner; the
 * groups that measure balance (`balance`) and footprint (`privacy`) hold all the runs of their
 * measurement, so no other work competes with it.
 */
const GROUPS = {
  coverage: (ctx) => [...exactlyOnce(ctx), ...filters(ctx), ...newTests(ctx)],
  serial: (ctx) => serialGroups(ctx),
  balance: () => [],
  assignment: (ctx) => [
    deterministicPlan(ctx),
    listMatchesRun(ctx),
    appliedByReporter(ctx),
    ...damagedTiming(ctx),
    noGitRepository(ctx),
    ...splitShards(ctx),
  ],
  history: (ctx) => [
    shardReports(ctx),
    ...reportProofs(ctx),
    damagedInputs(ctx),
    ...failedRuns(ctx),
    cancelledRun(ctx),
    fasterTest(ctx),
    windowRebuild(ctx),
    racingPublish(ctx),
  ],
};

const GROUP_NAMES = [...Object.keys(GROUPS), 'privacy'];

/** Removes the vendor's variables from the environment, so a developer's token cannot leak in. */
function clearVendorEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('FLAKINESS_') || name.startsWith('PSP_FLK_')) delete process.env[name];
  }
}

async function collectEvidence({ log = () => {}, requireOsBlock = false, group = 'all' } = {}) {
  const names = group === 'all' ? GROUP_NAMES : [group];
  for (const name of names) {
    if (!GROUP_NAMES.includes(name)) throw new Error(`unknown group ${name}`);
  }
  clearVendorEnvironment();
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
      balance: names.includes('balance') ? balance(ctx) : null,
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
