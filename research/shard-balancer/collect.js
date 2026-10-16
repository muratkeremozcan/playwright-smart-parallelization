'use strict';

/**
 * Collects the evidence of the harvest: every experiment row, the resolved versions, and the
 * check of every citation of the decisions. Row groups share one context, so a run several rows
 * read executes once. The evidence holds no local path: the context scrubs every row.
 */

const { playwrightVersion } = require('../../harness');
const { checkCitations, citationsOf } = require('./citations');
const { createContext } = require('./context');
const { ALL } = require('./decisions');
const { assignmentRows, planRows } = require('./scenarios/assignment');
const { historyRows } = require('./scenarios/history');
const { internalsRows } = require('./scenarios/internals');
const { networkRows } = require('./scenarios/network');
const { planningRows } = require('./scenarios/planning');
const { checkRows, safetyRows } = require('./scenarios/safety');
const {
  FLAKINESS,
  assertInstalled,
  manifest,
  packageInfo,
  publishedCommit,
} = require('./upstream');

const GROUPS = {
  assignment: assignmentRows,
  plan: planRows,
  safety: safetyRows,
  check: checkRows,
  history: historyRows,
  planning: planningRows,
  internals: internalsRows,
  network: networkRows,
};

const GROUP_NAMES = Object.keys(GROUPS);

/** Removes the variables of the package and of the Flakiness reporter from the environment. */
function clearEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (/^(PSP_PSB_|PLAYWRIGHT_SHARD_BALANCER_|FLAKINESS_|PSP_FLK_)/.test(name))
      delete process.env[name];
  }
}

async function collectEvidence({ log = () => {}, group = 'all' } = {}) {
  const names = group === 'all' ? GROUP_NAMES : [group];
  for (const name of names) {
    if (!GROUPS[name]) throw new Error(`unknown group ${name}; one of ${GROUP_NAMES.join(', ')}`);
  }
  assertInstalled();
  clearEnvironment();
  const started = Date.now();
  const info = packageInfo();
  const commit = publishedCommit(info.version);
  const ctx = createContext({ log });
  try {
    const rows = [];
    for (const name of names) {
      log(`group ${name}`);
      rows.push(...(await GROUPS[name](ctx)));
    }
    const citations = await checkCitations(citationsOf(ALL), { commit });
    return ctx.scrub({
      generatedAt: new Date().toISOString(),
      group,
      versions: {
        package: `${info.name}@${info.version}`,
        commit,
        playwright: playwrightVersion(ctx.cwd),
        flakiness: `${manifest(FLAKINESS).name}@${manifest(FLAKINESS).version}`,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      rows,
      citations,
      durationMs: Date.now() - started,
    });
  } finally {
    if (!process.env.PSP_KEEP_TMP) ctx.dispose();
  }
}

module.exports = { GROUP_NAMES, collectEvidence };
