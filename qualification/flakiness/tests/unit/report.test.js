/** Tests for the markdown tables that feed docs/qualification/flakiness.md. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { normalizeTable, renderBalance, renderFootprint, renderVersions } = require('../../report');

const figures = (slowest, violations = {}) => ({
  durationsMs: [slowest, slowest - 10],
  leaves: [26, 26],
  slowestMs: slowest,
  imbalance: 0.0034,
  violations,
});

const evidence = {
  versions: { engine: 'pkg@1.2.3', playwright: '9.9.9', node: 'v99.0.0', platform: 'linux-x64' },
  balance: [
    {
      shards: 2,
      native: figures(14000),
      engine: { ...figures(14300, { 'serial-split': 2 }), slowestVsNative: 0.0214 },
      nativeParallel: figures(7000),
      engineParallel: { ...figures(6900), slowestVsNative: -0.0143 },
    },
  ],
  footprint: {
    install: { packages: 1, nodeModulesBytes: 1572864, enginePackageBytes: 1310720 },
    playwright: {
      runs: 5,
      workers: 4,
      plain: {
        wallMs: 9000,
        wallMinMs: 8800,
        wallMaxMs: 9300,
        afterTestsMs: 700,
        mainRssKb: 102400,
        workerRssKb: 81920,
      },
      reporter: {
        wallMs: 9450,
        wallMinMs: 9100,
        wallMaxMs: 9900,
        afterTestsMs: 1100,
        mainRssKb: 122880,
        workerRssKb: 81920,
      },
    },
    timingsCommand: {
      runtimeMs: { help: 60, buildOne: 120, buildMerge: 130 },
      peakRssKb: { bareNode: 40960, help: 51200, buildOne: 81920, buildMerge: 92160 },
    },
    artifactBytes: {
      flakinessReport: 51200,
      flakinessFolder: 53248,
      playwrightJsonReport: 25600,
      timingsFile: 9216,
    },
    reportContent: { sourceFiles: 13, cpuSamples: 9, ramSamples: 9 },
    probeProcesses: { git: 4, vm_stat: 20 },
  },
};

describe('renderVersions', () => {
  test('lists the engine, Playwright, Node and the platform', () => {
    assert.strictEqual(
      renderVersions(evidence),
      [
        '| Component | Resolved version |',
        '| --- | --- |',
        '| Engine package | pkg@1.2.3 |',
        '| Playwright (fixture) | 9.9.9 |',
        '| Node | v99.0.0 |',
        '| Platform | linux-x64 |',
      ].join('\n')
    );
  });
});

describe('renderBalance', () => {
  const lines = renderBalance(evidence).split('\n');

  test('gives four strategies per shard count, native first in each pair', () => {
    assert.strictEqual(lines.length, 2 + 4);
    assert.deepStrictEqual(
      lines.slice(2).map((line) => line.split(' | ')[1]),
      ['native `--shard`', 'engine', 'native `--shard`, fullyParallel', 'engine, fullyParallel']
    );
  });

  test('shows the change against the matching native run and the violations', () => {
    assert.match(lines[3], /\| \+2\.1% \| serial-split 2 \|$/);
    assert.match(lines[5], /\| -1\.4% \| none \|$/);
    assert.match(lines[2], /\| baseline \| none \|$/);
  });
});

describe('renderFootprint', () => {
  const text = renderFootprint(evidence);

  test('shows the overhead of the reporter against the plain run', () => {
    assert.match(text, /Reporter overhead per run \| 450 ms \(\+5\.0%\)/);
  });

  test('shows the spread of the run times next to their medians', () => {
    assert.match(text, /Playwright run, plain native \| 9000 ms \(8800 to 9300\)/);
    assert.match(text, /Playwright run, with the reporter \| 9450 ms \(9100 to 9900\)/);
  });

  test('shows memory in MiB and artifact sizes in KiB', () => {
    assert.match(text, /Peak memory of the Playwright process, with the reporter \| 120\.0 MiB/);
    assert.match(text, /Flakiness report per run \| 50\.0 KiB/);
  });

  test('names the programs the reporter started with their counts', () => {
    assert.match(text, /Programs started in a two-shard run \| git 4, vm_stat 20/);
  });

  test('says none when the reporter started nothing', () => {
    const quiet = { ...evidence, footprint: { ...evidence.footprint, probeProcesses: {} } };
    assert.match(renderFootprint(quiet), /Programs started in a two-shard run \| none/);
  });
});

describe('normalizeTable', () => {
  test('makes a padded table equal to a rendered one', () => {
    const padded = '| A    | B  |\n| ---- | -- |\n| 1    | 2  |';
    assert.strictEqual(
      normalizeTable(padded),
      normalizeTable('| A | B |\n| --- | --- |\n| 1 | 2 |')
    );
  });
});
