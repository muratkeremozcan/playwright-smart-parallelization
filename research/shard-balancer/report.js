'use strict';

/**
 * Markdown renderers for `docs/research/shard-balancer-harvest.md`. The document embeds the output
 * of these functions for the committed evidence and the decisions, and a test compares them, so no
 * result, status or figure in the document is typed by hand.
 */

const { normalizeTable, table } = require('../../qualification/lib/tables');
const { INTERNALS, LISTS } = require('./decisions');

/** A table cell: pipes escaped, so code spans that hold a pipe stay in their cell. */
const cell = (text) => String(text).replaceAll('|', '\\|');

const sourceRef = (s) => `\`${s.source === 'upstream' ? '' : `${s.source}:`}${s.file}:${s.lines}\``;

function rowOf(evidence, id) {
  const found = evidence.rows.find((r) => r.id === id);
  if (!found) throw new Error(`the evidence has no row ${id}`);
  return found;
}

/** The resolved versions of the run. */
function renderVersions(evidence) {
  const v = evidence.versions;
  return table(
    ['Component', 'Resolved version'],
    [
      ['Package under study', v.package],
      ['Published commit', `\`${v.commit}\``],
      ['Playwright (fixture)', v.playwright],
      ['Flakiness reporter (internals rows)', v.flakiness],
      ['Node', v.node],
      ['Platform', v.platform],
    ]
  );
}

/** Every row: id, result, claim and finding. */
function renderRows(evidence) {
  return table(
    ['Row', 'Result', 'Claim', 'Finding'],
    evidence.rows.map((r) => [`\`${r.id}\``, r.status, cell(r.claim), cell(r.finding)])
  );
}

/** The rows a decision names, with the status each holds in the evidence. */
function evidenceCell(evidence, entry) {
  const ids = Object.keys(entry.evidence);
  if (ids.length === 0) return 'none';
  return ids.map((id) => `\`${id}\` ${rowOf(evidence, id).status}`).join(', ');
}

/** One list of decisions (`gaps`, `workflow` or `mechanisms`). */
function renderDecisions(evidence, name) {
  const list = LISTS[name];
  if (!list || name === 'internals') throw new Error(`no decision list ${name}`);
  return table(
    ['Subject', 'Mechanism', 'Source', 'Decision', 'Reason', 'Evidence'],
    list.map((entry) => [
      cell(entry.subject),
      cell(entry.mechanism),
      entry.sources.map(sourceRef).join(', '),
      entry.decision,
      cell(entry.reason),
      evidenceCell(evidence, entry),
    ])
  );
}

/** The internals each engine reads: what it does, the public replacement and the loss. */
function renderInternals(evidence) {
  return table(
    [
      'Field',
      'Engine',
      'What the read does',
      'Source',
      'Public replacement',
      'Loss without it',
      'Evidence',
    ],
    INTERNALS.map((entry) => [
      `\`${entry.field}\``,
      entry.engine,
      cell(entry.mechanism),
      entry.sources.map(sourceRef).join(', '),
      cell(entry.replacement),
      cell(entry.loss),
      evidenceCell(evidence, entry),
    ])
  );
}

const yesNo = (value) => (value ? 'yes' : 'no');
const codes = (list) => list.join(' / ');

/**
 * What each reporter does when an internal field is gone, for both engines in one table: a copy
 * of the reporter whose read names a property that does not exist, run through the harness.
 */
function renderInternalRuns(evidence) {
  const flk = rowOf(evidence, 'i.flakiness-internal').facts;
  const psbMode = rowOf(evidence, 'i.psb-no-parallel-mode').facts;
  const flkMode = rowOf(evidence, 'i.flakiness-no-parallel-mode').facts;
  const psbLocks = rowOf(evidence, 'i.psb-no-locks').facts;
  const modeRow = (engine, where, config, facts, log) => [
    engine,
    '`_parallelMode`',
    where,
    config,
    codes(facts.exitCodes),
    yesNo(facts.balances),
    yesNo(facts.harnessOk),
    String(facts.serialSplit),
    `${facts.splitFiles} files split`,
    cell(log),
  ];
  const psbWhere = '`src/reporter.ts:51-52,84`';
  const flkWhere = `\`${flk.file}:${flk.line}\``;
  const psbLog = (facts) => (facts.logLines[0] ? `\`${facts.logLines[0]}\`` : 'none');
  const flkLog = (facts) => (facts.warns ? 'a warning' : 'no warning about the field');
  return table(
    [
      'Engine',
      'Field removed',
      'Read at',
      'Config',
      'Exit codes',
      'Balances',
      'Exactly once',
      'Serial splits',
      'Grouping',
      'Log',
    ],
    [
      modeRow(
        'playwright-shard-balancer',
        psbWhere,
        'default',
        psbMode.default,
        psbLog(psbMode.default)
      ),
      modeRow(
        'playwright-shard-balancer',
        psbWhere,
        '`fullyParallel`',
        psbMode.fullyParallel,
        psbLog(psbMode.fullyParallel)
      ),
      modeRow(
        flk.package.replace(/@[^@]+$/, ''),
        flkWhere,
        'default',
        flkMode.default,
        flkLog(flkMode.default)
      ),
      modeRow(
        flk.package.replace(/@[^@]+$/, ''),
        flkWhere,
        '`fullyParallel`',
        flkMode.fullyParallel,
        flkLog(flkMode.fullyParallel)
      ),
      [
        'playwright-shard-balancer',
        '`_locks`',
        '`src/reporter.ts:105-107`',
        'lock suite',
        codes(psbLocks.exitCodes),
        yesNo(psbLocks.strategies.every((s) => s === 'balanced')),
        yesNo(psbLocks.harnessOk),
        String(psbLocks.violations['serial-split'] || 0),
        'lock tests on shards ' + psbLocks.shardsWithLock.join(' and '),
        cell(psbLocks.notes.map((n) => `\`${n}\``).join(', ')),
      ],
      [
        flk.package.replace(/@[^@]+$/, ''),
        '`_locks`',
        'not read',
        'any',
        'n/a',
        'n/a',
        'n/a',
        'n/a',
        'n/a',
        'the package has no read of `_locks`',
      ],
    ]
  );
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** `simulate` over the couture-cast suite of the S5 baseline, by test and by file. */
function renderCoutureCast(evidence) {
  const facts = rowOf(evidence, 'sim.couture-cast').facts;
  return table(
    [
      'Shards',
      'Built-in split',
      'Balanced by test',
      'Balanced by file',
      'Lower bound',
      'Elapsed with overhead',
      'Machine time with overhead',
    ],
    facts.byTest.map((r) => {
      const file = facts.byFile.find((f) => f.shards === r.shards);
      return [
        String(r.shards),
        seconds(r.builtinMs),
        seconds(r.balancedMs),
        seconds(file.balancedMs),
        seconds(r.lowerBoundMs),
        seconds(r.elapsedMs),
        seconds(r.machineMs),
      ];
    })
  );
}

/** Every take and adapt, with the acceptance test S8 must pass and the rows behind it. */
function renderInputs(evidence) {
  const rows = [];
  for (const name of ['gaps', 'workflow', 'mechanisms']) {
    for (const entry of LISTS[name]) {
      if (entry.decision === 'reject') continue;
      rows.push([
        cell(entry.subject),
        entry.decision,
        cell(entry.s8),
        evidenceCell(evidence, entry),
      ]);
    }
  }
  return table(['Subject', 'Decision', 'Acceptance test for S8', 'Rows'], rows);
}

/** How many citations each source holds and how many the collector found at their lines. */
function renderCitations(evidence) {
  const groups = new Map();
  for (const c of evidence.citations) {
    const key = c.source;
    const g = groups.get(key) || { files: new Set(), total: 0, ok: 0 };
    g.files.add(c.file);
    g.total += 1;
    if (c.ok) g.ok += 1;
    groups.set(key, g);
  }
  const label = {
    upstream: `\`${evidence.versions.package}\` at \`${evidence.versions.commit.slice(0, 12)}\``,
    flakiness: `installed \`${evidence.versions.flakiness}\``,
    playwright: `installed Playwright ${evidence.versions.playwright}`,
  };
  return table(
    ['Source', 'Files', 'Citations', 'Quote found at its lines'],
    [...groups].map(([key, g]) => [
      label[key] || key,
      String(g.files.size),
      String(g.total),
      String(g.ok),
    ])
  );
}

module.exports = {
  normalizeTable,
  renderCitations,
  renderCoutureCast,
  renderDecisions,
  renderInputs,
  renderInternalRuns,
  renderInternals,
  renderRows,
  renderVersions,
};
