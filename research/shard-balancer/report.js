'use strict';

/**
 * Markdown renderers for `docs/research/shard-balancer-harvest.md`. The document embeds the output
 * of these functions for the committed evidence and the decisions between
 * `<!-- generated:NAME -->` and `<!-- /generated:NAME -->` markers, and a test compares every block,
 * so no result, status or figure in the document is typed by hand.
 *
 *   node research/shard-balancer/report.js --write
 *
 * renders every block from `docs/research/shard-balancer-evidence.json` and writes it into the
 * document, formatted by the repository's Prettier config.
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeTable, table } = require('../../qualification/lib/tables');
const { INTERNALS, LISTS } = require('./decisions');

const REPO = path.resolve(__dirname, '..', '..');
const DOC = path.join(REPO, 'docs', 'research', 'shard-balancer-harvest.md');
const EVIDENCE = path.join(REPO, 'docs', 'research', 'shard-balancer-evidence.json');
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const word = (n) => WORDS[n] || String(n);

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
      'Decision',
      'Public replacement',
      'Loss without it',
      'Evidence',
    ],
    INTERNALS.map((entry) => [
      `\`${entry.field}\``,
      entry.engine,
      cell(entry.mechanism),
      entry.sources.map(sourceRef).join(', '),
      entry.decision,
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
  const readAt = (engine, field) => {
    const entry = INTERNALS.find((e) => e.engine === engine && e.field === field);
    return sourceRef(entry.readAt).replace(/^`[a-z]+:/, '`');
  };
  const psbWhere = readAt('playwright-shard-balancer', 'Suite._parallelMode');
  const flkWhere = readAt('@flakiness/playwright', 'Suite._parallelMode');
  if (flkWhere !== `\`${flk.file}:${flk.line}\``) {
    throw new Error(`the Flakiness read moved to ${flk.file}:${flk.line}; update its decision`);
  }
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
        readAt('playwright-shard-balancer', 'TestCase._locks'),
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

/** Every entry with an acceptance test for S8 (every take and adapt, and some rejects). */
function renderInputs(evidence) {
  const rows = [];
  for (const name of ['gaps', 'workflow', 'mechanisms', 'internals']) {
    for (const entry of LISTS[name]) {
      if (!entry.s8) continue;
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

/** For every take and adapt of the mechanisms: whether it works under shape A and shape B. */
function renderShapes(evidence) {
  const shape = (s) => [
    s.works ? 'yes' : 'no',
    `\`${s.row}\` ${rowOf(evidence, s.row).status}`,
    cell(s.s8),
  ];
  return table(
    [
      'Mechanism',
      'Decision',
      'Shape A',
      'Row',
      'Acceptance test under shape A',
      'Shape B',
      'Row',
      'Acceptance test under shape B',
    ],
    LISTS.mechanisms
      .filter((entry) => entry.decision !== 'reject')
      .map((entry) => [
        cell(entry.subject),
        entry.decision,
        ...shape(entry.shapes.a),
        ...shape(entry.shapes.b),
      ])
  );
}

/** The sentence before the table of internal runs, with the shard counts of those runs. */
function renderInternalRunsIntro(evidence) {
  const mode = rowOf(evidence, 'i.psb-no-parallel-mode').facts.default.exitCodes.length;
  const locks = rowOf(evidence, 'i.psb-no-locks').facts.exitCodes.length;
  return (
    'What each reporter does when a Playwright release drops the field, from a copy of the reporter whose read names a property that does not exist, run through the harness: ' +
    `the \`_parallelMode\` rows on the fixture with ${word(mode)} shards and one worker per shard, the \`_locks\` row on a suite of two lock files and a filler with ${word(locks)} shards. ` +
    "Balances means the shards ran other leaves than Playwright's own split; exactly once is the harness verdict, which includes serial integrity and dependencies."
  );
}

/** The sentence before the couture-cast table, with its shard range and overhead. */
function renderCoutureIntro(evidence) {
  const facts = rowOf(evidence, 'sim.couture-cast').facts;
  const shards = facts.byTest.map((r) => r.shards);
  return (
    `\`simulate\` over a list and timings built from the ${word(facts.runs)} S5 runs of couture-cast, ` +
    `${word(Math.min(...shards))} to ${word(Math.max(...shards))} shards, one worker per shard, with the median per-shard overhead outside the Playwright run, ` +
    `\`--overhead ${facts.overheadInput}\` (\`sim.couture-cast\`).`
  );
}

/** The notice code copied from the package carries. */
function renderCopyright(evidence) {
  return `Code copied from the package carries its notice: ${evidence.versions.license}, MIT License.`;
}

/** Every generated block of the document, by name. */
const BLOCKS = {
  versions: renderVersions,
  rows: renderRows,
  gaps: (e) => renderDecisions(e, 'gaps'),
  workflow: (e) => renderDecisions(e, 'workflow'),
  mechanisms: (e) => renderDecisions(e, 'mechanisms'),
  internals: renderInternals,
  'internal-runs-intro': renderInternalRunsIntro,
  'internal-runs': renderInternalRuns,
  'couture-intro': renderCoutureIntro,
  'couture-cast': renderCoutureCast,
  inputs: renderInputs,
  shapes: renderShapes,
  citations: renderCitations,
  copyright: renderCopyright,
};

const BLOCK = /<!-- generated:([a-z-]+) -->([\s\S]*?)<!-- \/generated:\1 -->/g;

/** The generated blocks of a document: `{ name: text }`. */
function blocksOf(text) {
  const found = {};
  for (const match of text.matchAll(BLOCK)) {
    if (match[1] in found) throw new Error(`the block ${match[1]} appears twice`);
    found[match[1]] = match[2].trim();
  }
  return found;
}

/** The document with every generated block rendered from the evidence. */
function renderDocument(text, evidence) {
  const names = Object.keys(blocksOf(text));
  const missing = Object.keys(BLOCKS).filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`the document has no block ${missing.join(', ')}`);
  return text.replace(BLOCK, (_, name) => {
    if (!BLOCKS[name]) throw new Error(`no renderer for the block ${name}`);
    return `<!-- generated:${name} -->\n\n${BLOCKS[name](evidence)}\n\n<!-- /generated:${name} -->`;
  });
}

/** Renders every block into the document and formats it with the repository's Prettier config. */
async function writeDocument({ doc = DOC, evidence = EVIDENCE } = {}) {
  const prettier = require('prettier');
  const rendered = renderDocument(
    fs.readFileSync(doc, 'utf8'),
    JSON.parse(fs.readFileSync(evidence, 'utf8'))
  );
  const options = { ...(await prettier.resolveConfig(doc)), filepath: doc };
  fs.writeFileSync(doc, await prettier.format(rendered, options));
}

if (require.main === module) {
  if (process.argv[2] !== '--write') {
    process.stderr.write('usage: node research/shard-balancer/report.js --write\n');
    process.exitCode = 2;
  } else {
    writeDocument().then(
      () => process.stdout.write(`Tables written to ${path.relative(REPO, DOC)}\n`),
      (error) => {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = 2;
      }
    );
  }
}

module.exports = {
  BLOCKS,
  blocksOf,
  normalizeTable,
  renderCopyright,
  renderShapes,
  renderCoutureIntro,
  renderDocument,
  renderInternalRunsIntro,
  writeDocument,
  renderCitations,
  renderCoutureCast,
  renderDecisions,
  renderInputs,
  renderInternalRuns,
  renderInternals,
  renderRows,
  renderVersions,
};
