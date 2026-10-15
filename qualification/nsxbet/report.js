'use strict';

/**
 * Markdown renderers for the numbers in `docs/qualification/nsxbet.md`. The document embeds the
 * output of these functions for the committed reference evidence, and a test compares them, so
 * no figure in the document is typed by hand.
 */

const KIB = 1024;

function kib(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function mib(bytes) {
  return `${(bytes / KIB / KIB).toFixed(1)} MiB`;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPercent(value) {
  return `${value >= 0 ? '+' : ''}${percent(value)}`;
}

function kinds(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? 'none' : entries.map(([kind, n]) => `${kind} ${n}`).join(', ');
}

function table(header, rows) {
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`table row has ${row.length} cells for ${header.length} columns`);
    }
  }
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** The resolved versions of the run. */
function renderVersions(evidence) {
  const { engine, playwright, node, platform } = evidence.versions;
  return table(
    ['Component', 'Resolved version'],
    [
      ['Engine package', engine],
      ['Playwright (fixture)', playwright],
      ['Node', node],
      ['Platform', platform],
    ]
  );
}

/** Slowest shard and imbalance, native sharding against the engine. */
function renderBalance(evidence) {
  const rows = evidence.balance.flatMap((entry) => {
    const line = (label, figures, change) => [
      String(entry.shards),
      label,
      figures.leaves.join(' / '),
      figures.durationsMs.join(' / '),
      String(figures.slowestMs),
      percent(figures.imbalance),
      change === undefined ? 'baseline' : signedPercent(change),
      kinds(figures.violations),
    ];
    return [
      line('native `--shard`', entry.native),
      line('engine', entry.engine, entry.engine.slowestVsNative),
      line('engine with serial groups kept whole', entry.grouped, entry.grouped.slowestVsNative),
    ];
  });
  return table(
    [
      'Shards',
      'Strategy',
      'Leaves per shard',
      'Shard ms',
      'Slowest ms',
      'Imbalance',
      'Slowest vs native',
      'Violations',
    ],
    rows
  );
}

/** Install size, runtime of each command and artifact sizes. */
function renderFootprint(evidence) {
  const { install, runtimeMs, artifactBytes } = evidence.footprint;
  return table(
    ['Measure', 'Value'],
    [
      ['Packages installed (engine and dependencies)', String(install.packages)],
      ['`node_modules` size', mib(install.nodeModulesBytes)],
      ['Engine package size', kib(install.enginePackageBytes)],
      ['`--version` (Node and CLI start-up)', `${runtimeMs.version} ms`],
      ['`assign`, no history, 3 shards', `${runtimeMs.assignCold} ms`],
      ['`assign`, with history, 3 shards', `${runtimeMs.assignHistory} ms`],
      ['`extract-timing`, one shard report', `${runtimeMs.extractTiming} ms`],
      ['`merge-timing`, one artifact into history', `${runtimeMs.mergeTiming} ms`],
      ['Assignment JSON', kib(artifactBytes.assignmentJson)],
      ['Test-list file per shard', artifactBytes.testListPerShard.map(kib).join(' / ')],
      ['Timing artifact per shard', kib(artifactBytes.timingArtifact)],
      ['Merged history file', kib(artifactBytes.mergedHistory)],
      [
        'Playwright JSON report (input to `extract-timing`)',
        kib(artifactBytes.playwrightJsonReport),
      ],
    ]
  );
}

/** Collapses table padding so a hand-formatted table equals a rendered one. */
function normalizeTable(text) {
  return text
    .split('\n')
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim().replace(/^-+$/, '---'))
        .join('|')
    )
    .join('\n');
}

module.exports = { normalizeTable, renderBalance, renderFootprint, renderVersions };
