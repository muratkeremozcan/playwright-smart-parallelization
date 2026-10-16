'use strict';

/**
 * Markdown renderers for the numbers in `docs/qualification/nsxbet.md`. The document embeds the
 * output of these functions for the committed reference evidence, and a test compares them, so
 * no figure in the document is typed by hand.
 */

const {
  KIB,
  kib,
  kinds,
  mib,
  normalizeTable,
  percent,
  signedPercent,
  table,
} = require('../lib/tables');

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
  const { install, runtimeMs, peakRssKb, artifactBytes } = evidence.footprint;
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
      ['Peak memory, empty Node process', mib(peakRssKb.bareNode * KIB)],
      ['Peak memory, `--version`', mib(peakRssKb.version * KIB)],
      ['Peak memory, `assign`, no history', mib(peakRssKb.assignCold * KIB)],
      ['Peak memory, `assign`, with history', mib(peakRssKb.assignHistory * KIB)],
      ['Peak memory, `extract-timing`', mib(peakRssKb.extractTiming * KIB)],
      ['Peak memory, `merge-timing`', mib(peakRssKb.mergeTiming * KIB)],
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

module.exports = { normalizeTable, renderBalance, renderFootprint, renderVersions };
