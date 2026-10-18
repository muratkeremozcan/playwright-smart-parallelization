/** Tests for the pure checks, one block per I/O matrix row, on synthetic data. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const checks = require('../harness/checks.js');

function leaf(project, name, extra = {}) {
  return {
    key: `${project}|f.js|${name}|#0`,
    project,
    serialGroup: null,
    dependency: false,
    ...extra,
  };
}

const setup = leaf('setup', 'prepare', { dependency: true });
const teardown = leaf('teardown', 'clean', { dependency: true });
const a = leaf('chromium', 'a');
const b = leaf('chromium', 'b');
const one = leaf('chromium', 'one', { serialGroup: 'chromium|s.js|0:0|#0' });
const two = leaf('chromium', 'two', { serialGroup: 'chromium|s.js|0:0|#0' });
const intended = [setup, teardown, a, b, one, two];
const dependencies = { chromium: ['setup', 'teardown'], setup: ['teardown'], teardown: [] };

const shard = (index, leaves, exitCode = 0) => ({ index, exitCode, leaves });
const clean = [shard(1, [setup, a, one, two, teardown]), shard(2, [setup, b, teardown])];

const kinds = (violations) => violations.map((violation) => violation.kind);

describe('clean partition', () => {
  test('raises no violation', () => {
    assert.deepStrictEqual(checks.checkCoverage(intended, clean), []);
    assert.deepStrictEqual(checks.checkSerialGroups(intended, clean), []);
    assert.deepStrictEqual(checks.checkDependencies(intended, clean, dependencies), []);
    assert.deepStrictEqual(checks.checkShardRuns(clean), []);
  });

  test('counts dependency executions separately from primary leaves', () => {
    assert.deepStrictEqual(checks.countDependencyExecutions(intended, clean), {
      [setup.key]: 2,
      [teardown.key]: 2,
    });
  });
});

describe('checkCoverage', () => {
  test('reports a dropped leaf as missing and names the key', () => {
    const shards = [shard(1, [setup, a, one, two, teardown]), shard(2, [setup, teardown])];
    assert.deepStrictEqual(checks.checkCoverage(intended, shards), [
      { kind: 'missing', key: b.key, detail: 'no shard ran this leaf' },
    ]);
  });

  test('reports a leaf in two shards as duplicate', () => {
    const shards = [shard(1, [setup, a, b, one, two, teardown]), shard(2, [setup, b, teardown])];
    const violations = checks.checkCoverage(intended, shards);
    assert.deepStrictEqual(kinds(violations), ['duplicate']);
    assert.strictEqual(violations[0].key, b.key);
  });

  test('reports a leaf twice in one shard as duplicate', () => {
    const shards = [shard(1, [setup, a, a, one, two, teardown]), shard(2, [setup, b, teardown])];
    assert.deepStrictEqual(kinds(checks.checkCoverage(intended, shards)), ['duplicate']);
  });

  test('reports a leaf outside the intended set as unexpected', () => {
    const stray = leaf('chromium', 'stray');
    const shards = [
      shard(1, [setup, a, stray, one, two, teardown]),
      shard(2, [setup, b, teardown]),
    ];
    const violations = checks.checkCoverage(intended, shards);
    assert.deepStrictEqual(kinds(violations), ['unexpected']);
    assert.strictEqual(violations[0].key, stray.key);
  });

  test('does not count dependency leaves as duplicates', () => {
    assert.deepStrictEqual(checks.checkCoverage(intended, clean), []);
  });

  test('treats a shard without leaves as running nothing', () => {
    const shards = [shard(1, null), shard(2, [setup, b, teardown])];
    assert.deepStrictEqual(kinds(checks.checkCoverage(intended, shards)), [
      'missing',
      'missing',
      'missing',
    ]);
  });
});

describe('checkExecution', () => {
  const ran = (item, outcome = 'expected') => ({ ...item, outcome });
  const executed = [
    shard(1, [ran(setup), ran(a), ran(one, 'flaky'), ran(two), ran(teardown)]),
    shard(2, [ran(setup), ran(b, 'unexpected'), ran(teardown)]),
  ];

  test('accepts every terminal outcome', () => {
    assert.deepStrictEqual(checks.checkExecution(intended, executed), []);
  });

  test('reports a primary leaf that skipped as not-executed, with its key and shard', () => {
    const shards = [
      shard(1, [ran(setup), ran(a, 'skipped'), ran(one), ran(two), ran(teardown)]),
      executed[1],
    ];
    const violations = checks.checkExecution(intended, shards);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.kind, violation.shard, violation.key]),
      [['not-executed', 1, a.key]]
    );
    assert.match(violations[0].detail, /skipped/);
  });

  test('reports a leaf that carries no outcome as never reported', () => {
    const shards = [shard(1, [ran(setup), a, ran(one), ran(two), ran(teardown)]), executed[1]];
    const violations = checks.checkExecution(intended, shards);
    assert.deepStrictEqual(kinds(violations), ['not-executed']);
    assert.match(violations[0].detail, /no outcome/);
  });

  test('reports a dependency leaf that skipped', () => {
    const shards = [executed[0], shard(2, [ran(setup, 'skipped'), ran(b), ran(teardown)])];
    const violations = checks.checkExecution(intended, shards);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.kind, violation.shard, violation.key]),
      [['not-executed', 2, setup.key]]
    );
  });

  test('reports every leaf of a run where everything skipped', () => {
    const skippedAll = clean.map((item) => ({
      ...item,
      leaves: item.leaves.map((entry) => ran(entry, 'skipped')),
    }));
    const violations = checks.checkExecution(intended, skippedAll);
    assert.strictEqual(violations.length, 8);
    assert.deepStrictEqual(new Set(kinds(violations)), new Set(['not-executed']));
  });

  test('leaves a leaf outside the intended set to checkCoverage', () => {
    const stray = ran(leaf('chromium', 'stray'), 'skipped');
    assert.deepStrictEqual(checks.checkExecution(intended, [shard(1, [stray])]), []);
  });

  test('treats a shard without leaves as running nothing', () => {
    assert.deepStrictEqual(checks.checkExecution(intended, [shard(1, null)]), []);
  });
});

describe('an explicitly selected dependency project', () => {
  // `--project=setup`: the setup leaf is primary and the teardown leaf is its implicit dependency.
  const selectedSetup = { ...setup, dependency: false };
  const explicit = [selectedSetup, teardown];
  const chain = { setup: ['teardown'], teardown: [] };

  test('is missing when a partition runs only teardown', () => {
    const shards = [shard(1, [teardown]), shard(2, [])];
    assert.deepStrictEqual(
      checks.checkCoverage(explicit, shards).map((violation) => [violation.kind, violation.key]),
      [['missing', setup.key]]
    );
  });

  test('is accepted when one shard runs it with its teardown', () => {
    const shards = [shard(1, [selectedSetup, teardown]), shard(2, [])];
    assert.deepStrictEqual(checks.checkCoverage(explicit, shards), []);
    assert.deepStrictEqual(checks.checkDependencies(explicit, shards, chain), []);
  });

  test('is a duplicate when two shards run it', () => {
    const shards = [shard(1, [selectedSetup, teardown]), shard(2, [selectedSetup, teardown])];
    assert.deepStrictEqual(kinds(checks.checkCoverage(explicit, shards)), ['duplicate']);
  });

  test('needs its teardown in the shard that runs it', () => {
    const shards = [shard(1, [selectedSetup]), shard(2, [])];
    assert.deepStrictEqual(
      checks.checkDependencies(explicit, shards, chain).map((violation) => violation.kind),
      ['dependency-missing']
    );
  });

  test('stays exempt from the exactly-once check as an implicit dependency', () => {
    const implicit = [setup, teardown, a];
    const shards = [shard(1, [setup, a, teardown]), shard(2, [])];
    assert.deepStrictEqual(checks.checkCoverage(implicit, shards), []);
  });
});

describe('checkSerialGroups', () => {
  test('reports members of one group in two shards', () => {
    const shards = [shard(1, [setup, a, one, teardown]), shard(2, [setup, b, two, teardown])];
    const violations = checks.checkSerialGroups(intended, shards);
    assert.deepStrictEqual(kinds(violations), ['serial-split']);
    assert.strictEqual(violations[0].group, 'chromium|s.js|0:0|#0');
  });

  test('accepts a group that stays whole in any shard', () => {
    const shards = [shard(1, [setup, a, b, teardown]), shard(2, [setup, one, two, teardown])];
    assert.deepStrictEqual(checks.checkSerialGroups(intended, shards), []);
  });
});

describe('checkDependencies', () => {
  test('reports a shard that runs dependents without setup or teardown', () => {
    const shards = [shard(1, [setup, a, one, two, teardown]), shard(2, [b])];
    const violations = checks.checkDependencies(intended, shards, dependencies);
    assert.deepStrictEqual(kinds(violations), ['dependency-missing', 'dependency-missing']);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.shard, violation.key]),
      [
        [2, setup.key],
        [2, teardown.key],
      ]
    );
  });

  test('reports a missing teardown alone', () => {
    const shards = [shard(1, [setup, a, one, two, teardown]), shard(2, [setup, b])];
    const violations = checks.checkDependencies(intended, shards, dependencies);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.kind, violation.key]),
      [['dependency-missing', teardown.key]]
    );
  });

  test('reports a dependency leaf twice in one shard', () => {
    const shards = [
      shard(1, [setup, setup, a, one, two, teardown]),
      shard(2, [setup, b, teardown]),
    ];
    const violations = checks.checkDependencies(intended, shards, dependencies);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.kind, violation.shard, violation.key]),
      [['dependency-duplicate', 1, setup.key]]
    );
  });

  test('requires nothing of a shard that runs no dependent leaf', () => {
    const shards = [shard(1, [setup, a, b, one, two, teardown]), shard(2, [])];
    assert.deepStrictEqual(checks.checkDependencies(intended, shards, dependencies), []);
  });

  test('follows dependencies transitively', () => {
    const chain = { chromium: ['setup'], setup: ['base'], base: [] };
    const base = leaf('base', 'seed', { dependency: true });
    const all = [base, setup, a];
    const violations = checks.checkDependencies(all, [shard(1, [setup, a])], chain);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.kind, violation.key]),
      [['dependency-missing', base.key]]
    );
  });
});

describe('checkShardRuns', () => {
  test('reports a nonzero exit code', () => {
    const violations = checks.checkShardRuns([shard(1, [], 1), shard(2, [], 0)]);
    assert.deepStrictEqual(
      violations.map((violation) => [violation.kind, violation.shard]),
      [['shard-failed', 1]]
    );
  });

  test('reports a missing leaves file', () => {
    const violations = checks.checkShardRuns([shard(1, null, 0)]);
    assert.deepStrictEqual(kinds(violations), ['shard-failed']);
    assert.match(violations[0].detail, /no leaves file/);
  });
});

describe('imbalance', () => {
  test('is the slowest shard over the mean, minus one', () => {
    const value = checks.imbalance([{ durationMs: 100 }, { durationMs: 200 }, { durationMs: 300 }]);
    assert.strictEqual(value, 0.5);
  });

  test('is zero for equal shards, no shards, and zero durations', () => {
    assert.strictEqual(checks.imbalance([{ durationMs: 5 }, { durationMs: 5 }]), 0);
    assert.strictEqual(checks.imbalance([]), 0);
    assert.strictEqual(checks.imbalance([{ durationMs: 0 }, { durationMs: 0 }]), 0);
  });
});
