'use strict';

/**
 * Markdown renderers for `docs/qualification/comparison.md`, built from the evidence of the two
 * engines. The document embeds the output of these functions for the committed reference
 * evidence, and a test compares them, so no figure in it is typed by hand.
 */

const { KIB, kinds, mib, percent, signedPercent, table } = require('./tables');

/** Row results by id. */
function statusById(evidence) {
  return new Map(evidence.rows.map((row) => [row.id, row.status]));
}

/** The result of each proof and extra case side by side. */
function renderResults(nsx, flakiness) {
  const results = (evidence) => [...evidence.proofs, ...evidence.extras];
  const flakinessById = new Map(
    results(flakiness).map((entry) => [entry.number ?? entry.id, entry])
  );
  const rows = results(nsx).map((entry) => {
    const key = entry.number ?? entry.id;
    const other = flakinessById.get(key);
    const label = typeof key === 'number' ? `P${key}` : key.toUpperCase();
    return [label, entry.title, entry.status, other.status];
  });
  return table(['Proof', 'What the proof asks', 'NSXBet', 'Flakiness'], rows);
}

/** The rows both engines have under one id that ended differently. */
function renderDifferences(nsx, flakiness) {
  const theirs = statusById(flakiness);
  const rows = nsx.rows
    .filter((row) => theirs.has(row.id) && theirs.get(row.id) !== row.status)
    .map((row) => [`\`${row.id}\``, row.status, theirs.get(row.id)]);
  return table(['Row', 'NSXBet', 'Flakiness'], rows);
}

/** Slowest shard against native sharding, for each engine and shard count. */
function renderBalance(nsx, flakiness) {
  const rows = nsx.balance.flatMap((entry, index) => {
    const other = flakiness.balance[index];
    if (other.shards !== entry.shards)
      throw new Error('the balance tables list other shard counts');
    const line = (engine, label, figures, native) => [
      String(entry.shards),
      engine,
      label,
      String(figures.slowestMs),
      figures.slowestVsNative === undefined ? 'baseline' : signedPercent(figures.slowestVsNative),
      percent(figures.imbalance),
      kinds(figures.violations),
      String(native.slowestMs),
    ];
    return [
      line('NSXBet', 'native `--shard`', entry.native, entry.native),
      line('NSXBet', 'engine', entry.engine, entry.native),
      line('NSXBet', 'engine with serial groups kept whole (shim)', entry.grouped, entry.native),
      line('Flakiness', 'native `--shard`', other.native, other.native),
      line('Flakiness', 'engine', other.engine, other.native),
      line('Flakiness', 'engine, fullyParallel', other.engineParallel, other.nativeParallel),
    ];
  });
  return table(
    [
      'Shards',
      'Engine',
      'Strategy',
      'Slowest ms',
      'Against its native run',
      'Imbalance',
      'Violations',
      'Native ms',
    ],
    rows
  );
}

/** What each engine adds to a pipeline. */
function renderFootprint(nsx, flakiness) {
  const a = nsx.footprint;
  const b = flakiness.footprint;
  const { plain, reporter } = b.playwright;
  return table(
    ['Measure', 'NSXBet', 'Flakiness'],
    [
      ['Packages installed', String(a.install.packages), String(b.install.packages)],
      ['`node_modules` size', mib(a.install.nodeModulesBytes), mib(b.install.nodeModulesBytes)],
      [
        'Where it runs',
        'A planning command before the shards; the shards run as they are',
        'Inside every shard, as a Playwright reporter',
      ],
      [
        'Time added to a shard run',
        'none',
        `${reporter.wallMs - plain.wallMs} ms (${signedPercent((reporter.wallMs - plain.wallMs) / plain.wallMs)})`,
      ],
      [
        'Planning step, once per run',
        `${a.runtimeMs.assignHistory} ms (\`assign\` with history)`,
        'none, each shard plans for itself',
      ],
      [
        'Peak memory added to the Playwright process',
        'none',
        mib((reporter.mainRssKb - plain.mainRssKb) * KIB),
      ],
      [
        'Largest artifact per shard',
        `${(a.artifactBytes.timingArtifact / KIB).toFixed(1)} KiB timing artifact`,
        `${(b.artifactBytes.flakinessFolder / KIB).toFixed(1)} KiB report folder`,
      ],
      [
        'Network audit',
        auditResult(nsx, 'net.plan-timing'),
        auditResult(flakiness, 'net.balanced-run'),
      ],
    ]
  );
}

function auditResult(evidence, id) {
  const control = evidence.rows.find((row) => row.id === 'net.mutation-control');
  const row = evidence.rows.find((candidate) => candidate.id === id);
  return `${row.status}; mutation control ${control.status}`;
}

module.exports = { renderBalance, renderDifferences, renderFootprint, renderResults };
