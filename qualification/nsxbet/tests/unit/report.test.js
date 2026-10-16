/** Tests for the markdown tables that feed docs/qualification/nsxbet.md. */

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
      grouped: { ...figures(13900), slowestVsNative: -0.0071 },
    },
  ],
  footprint: {
    install: { packages: 59, nodeModulesBytes: 9787094, enginePackageBytes: 161525 },
    peakRssKb: {
      bareNode: 40960,
      version: 61440,
      assignCold: 81920,
      assignHistory: 71680,
      extractTiming: 66560,
      mergeTiming: 64512,
    },
    runtimeMs: {
      version: 74,
      assignCold: 581,
      assignHistory: 189,
      extractTiming: 74,
      mergeTiming: 75,
    },
    artifactBytes: {
      assignmentJson: 2562,
      testListPerShard: [590, 283],
      timingArtifact: 1583,
      mergedHistory: 5039,
      playwrightJsonReport: 50738,
    },
  },
};

const cells = (line) =>
  line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());

describe('renderBalance', () => {
  const lines = renderBalance(evidence).split('\n');

  test('every row has one cell per column', () => {
    const width = cells(lines[0]).length;
    assert.ok(lines.every((line) => cells(line).length === width));
    assert.strictEqual(width, 8);
  });

  test('puts each figure under its header', () => {
    const header = cells(lines[0]);
    const engine = cells(lines[3]);
    const at = (name) => engine[header.indexOf(name)];
    assert.strictEqual(at('Strategy'), 'engine');
    assert.strictEqual(at('Leaves per shard'), '26 / 26');
    assert.strictEqual(at('Shard ms'), '14300 / 14290');
    assert.strictEqual(at('Slowest ms'), '14300');
    assert.strictEqual(at('Imbalance'), '0.3%');
    assert.strictEqual(at('Slowest vs native'), '+2.1%');
    assert.strictEqual(at('Violations'), 'serial-split 2');
  });

  test('marks native sharding as the baseline and shows a faster run as negative', () => {
    assert.strictEqual(cells(lines[2])[6], 'baseline');
    assert.strictEqual(cells(lines[4])[6], '-0.7%');
  });
});

describe('renderVersions and renderFootprint', () => {
  test('list the resolved versions', () => {
    const text = renderVersions(evidence);
    for (const value of ['pkg@1.2.3', '9.9.9', 'v99.0.0', 'linux-x64'])
      assert.ok(text.includes(value));
  });

  test('formats sizes and runtimes', () => {
    const text = renderFootprint(evidence);
    assert.ok(text.includes('9.3 MiB'));
    assert.ok(text.includes('157.7 KiB'));
    assert.ok(text.includes('581 ms'));
    assert.ok(text.includes('0.6 KiB / 0.3 KiB'));
    assert.ok(text.includes('40.0 MiB'));
    assert.ok(text.includes('80.0 MiB'));
  });
});

describe('normalizeTable', () => {
  test('makes a padded table equal to a compact one', () => {
    const compact = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const padded = '| a   | b   |\n| --- | --- |\n| 1   | 2   |';
    assert.strictEqual(normalizeTable(padded), normalizeTable(compact));
  });
});
