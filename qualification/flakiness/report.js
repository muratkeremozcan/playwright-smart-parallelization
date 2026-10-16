'use strict';

/**
 * Markdown renderers for the numbers in `docs/qualification/flakiness.md`. The document embeds the
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

/** Slowest shard and imbalance, native sharding against the engine, for both units of sharding. */
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
      line('native `--shard`, fullyParallel', entry.nativeParallel),
      line('engine, fullyParallel', entry.engineParallel, entry.engineParallel.slowestVsNative),
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

function programs(counts) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'none' : entries.map(([name, n]) => `${name} ${n}`).join(', ');
}

/** What the reporter costs: install size, runtime, memory, artifacts and started processes. */
function renderFootprint(evidence) {
  const { install, playwright, timingsCommand, artifactBytes, reportContent, probeProcesses } =
    evidence.footprint;
  const { plain, reporter } = playwright;
  const overhead = reporter.wallMs - plain.wallMs;
  const { runtimeMs, peakRssKb } = timingsCommand;
  return table(
    ['Measure', 'Value'],
    [
      ['Packages installed (engine and dependencies)', String(install.packages)],
      ['`node_modules` size', mib(install.nodeModulesBytes)],
      ['Engine package size', mib(install.enginePackageBytes)],
      ['Playwright run, plain native', `${plain.wallMs} ms`],
      ['Playwright run, with the reporter', `${reporter.wallMs} ms`],
      ['Reporter overhead per run', `${overhead} ms (${signedPercent(overhead / plain.wallMs)})`],
      ['After the last test, plain native', `${plain.afterTestsMs} ms`],
      ['After the last test, with the reporter', `${reporter.afterTestsMs} ms`],
      ['Peak memory of the Playwright process, plain native', mib(plain.mainRssKb * KIB)],
      ['Peak memory of the Playwright process, with the reporter', mib(reporter.mainRssKb * KIB)],
      ['Peak memory of the largest worker, plain native', mib(plain.workerRssKb * KIB)],
      ['Peak memory of the largest worker, with the reporter', mib(reporter.workerRssKb * KIB)],
      ['Flakiness report per run', kib(artifactBytes.flakinessReport)],
      ['Flakiness report folder per run', kib(artifactBytes.flakinessFolder)],
      ['Playwright JSON report of the same run', kib(artifactBytes.playwrightJsonReport)],
      ['Timings file from one report', kib(artifactBytes.timingsFile)],
      ['Source files stored in the report', String(reportContent.sourceFiles)],
      [
        'CPU and memory samples in the report',
        `${reportContent.cpuSamples} / ${reportContent.ramSamples}`,
      ],
      ['Programs started in a two-shard run', programs(probeProcesses)],
      ['`--help` (Node and CLI start-up)', `${runtimeMs.help} ms`],
      ['`build`, one report', `${runtimeMs.buildOne} ms`],
      ['`build`, history and one report', `${runtimeMs.buildMerge} ms`],
      ['Peak memory, empty Node process', mib(peakRssKb.bareNode * KIB)],
      ['Peak memory, `--help`', mib(peakRssKb.help * KIB)],
      ['Peak memory, `build`, one report', mib(peakRssKb.buildOne * KIB)],
      ['Peak memory, `build`, history and one report', mib(peakRssKb.buildMerge * KIB)],
    ]
  );
}

module.exports = { normalizeTable, renderBalance, renderFootprint, renderVersions };
