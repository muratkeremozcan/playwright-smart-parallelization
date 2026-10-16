/**
 * The planner: the ported partition search and setup-aware balance, the estimator hierarchy and
 * the units. The plan must be deterministic, never predicted slower than Playwright's own split,
 * and must price setup only on the shards that host a test needing it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { balance, builtin } = require('../lib/plan/balance');
const { createEstimator, median, testKey } = require('../lib/plan/estimate');
const { partition, wallTime } = require('../lib/plan/partition');
const {
  buildUnits,
  dependencyProjects,
  setupCosts,
  setupPhases,
  unitId,
} = require('../lib/plan/units');

const unit = (id, cost, deps = [], order = 0) => ({
  id: unitId('chromium', `${id}.spec.js`, 0),
  project: 'chromium',
  file: `${id}.spec.js`,
  keys: [id],
  cost,
  order,
  active: 1,
  unknown: 0,
  deps,
});

const units = (costs, deps = []) => costs.map((cost, i) => unit(`f${i}`, cost, deps, i));

describe('partition', () => {
  test('finds the even split of a small set and is deterministic', () => {
    const items = [5, 4, 3, 3, 2, 1].map((cost, order) => ({ cost, order }));
    const a = partition(items, 2);
    assert.strictEqual(a.makespan, 9);
    assert.deepStrictEqual(partition(items, 2), a);
  });

  test('wall time packs a shard onto its workers in load order', () => {
    const items = [4, 4, 2].map((cost, order) => ({ cost, order }));
    assert.strictEqual(wallTime(items, [0, 1, 2], 1), 10);
    assert.strictEqual(wallTime(items, [0, 1, 2], 2), 6);
  });

  test('refuses a shard count that is not a positive integer', () => {
    assert.throws(() => partition([], 0), /positive integer/);
  });
});

describe('balance', () => {
  test('is never predicted slower than the built-in split, at any shard count', () => {
    const list = units([9000, 400, 300, 250, 200, 180, 150, 120, 90, 60, 1800, 2200]);
    for (let n = 1; n <= 6; n++) {
      const plan = balance(list, n);
      assert.ok(plan.makespanMs <= builtin(list, n).makespanMs, `n=${n}`);
      assert.strictEqual(plan.shards.length, n);
      assert.strictEqual(
        plan.shards.reduce((acc, s) => acc + s.units.length, 0),
        list.length
      );
    }
  });

  test('the same units give the same plan sha', () => {
    const list = units([500, 300, 300, 200, 100, 100, 50]);
    assert.strictEqual(
      balance(list, 3).sha,
      balance(units([500, 300, 300, 200, 100, 100, 50]), 3).sha
    );
    assert.match(balance(list, 3).sha, /^[0-9a-f]{64}$/);
  });

  test('prices setup only on the shards that host a unit needing it', () => {
    const list = [
      ...units([1000, 1000], ['setup']),
      unit('free-a', 1000, [], 2),
      unit('free-b', 1000, [], 3),
    ];
    const plan = balance(list, 2, 1, new Map([['setup', 300]]), new Map([['setup', 0]]));
    for (const shard of plan.shards) {
      const needs = shard.units.some((u) => u.deps.includes('setup'));
      assert.strictEqual(shard.setupMs, needs ? 300 : 0);
      assert.strictEqual(shard.wallMs, shard.sumMs + shard.setupMs);
    }
  });

  test('packs for the workers it is given', () => {
    const list = units([400, 400, 400, 400]);
    assert.strictEqual(balance(list, 1, 1).makespanMs, 1600);
    assert.strictEqual(balance(list, 1, 2).makespanMs, 800);
  });
});

describe('estimator', () => {
  const k = (...titles) => testKey('chromium', 'cart.spec.js', titles);
  const tests = {
    [k('cart', 'a')]: {
      samples: [
        [1, 100],
        [2, 120],
        [3, 110],
      ],
    },
    [k('cart', 'b')]: { samples: [[1, 500]] },
    [k('loose')]: { samples: [[1, 2000]] },
    [testKey('chromium', 'other.spec.js', ['x'])]: { samples: [[1, 40]] },
    [testKey('chromium', 'other.spec.js', ['y'])]: { samples: [[1, 45]] },
    [testKey('firefox', 'other.spec.js', ['x'])]: { samples: [[1, 3000]] },
    [testKey('firefox', 'other.spec.js', ['y'])]: { samples: [[1, 4000]] },
    [testKey('firefox', 'other.spec.js', ['z'])]: { samples: [[1, 5000]] },
  };
  const estimator = createEstimator(tests);

  test('a known test costs the median of its samples', () => {
    assert.strictEqual(estimator.estimate({ key: k('cart', 'a') }), 110);
    assert.strictEqual(estimator.knownCount, 8);
  });

  test('a new test costs its describe, then its file, then its project, then the suite', () => {
    assert.strictEqual(estimator.estimate({ key: k('cart', 'new') }), 305);
    assert.strictEqual(estimator.estimate({ key: k('new') }), 500);
    assert.strictEqual(estimator.estimate({ key: testKey('chromium', 'new.spec.js', ['x']) }), 110);
    assert.strictEqual(estimator.estimate({ key: testKey('webkit', 'new.spec.js', ['x']) }), 1250);
  });

  test('a test skipped before it runs costs nothing, and an empty history prices at 1 ms', () => {
    assert.strictEqual(estimator.estimate({ key: k('cart', 'a'), staticSkip: true }), 0);
    assert.strictEqual(createEstimator({}).estimate({ key: k('x') }), 1);
  });

  test('median of an even count rounds the midpoint', () => {
    assert.strictEqual(median([1, 2]), 2);
    assert.strictEqual(median([3, 1, 2]), 2);
  });
});

describe('units', () => {
  test('one unit per project, spec file and repeat, with unknown tests counted', () => {
    const estimator = createEstimator({
      [testKey('chromium', 'a.spec.js', ['x'])]: { samples: [[1, 100]] },
    });
    const tests = [
      {
        key: testKey('chromium', 'a.spec.js', ['x']),
        project: 'chromium',
        file: 'a.spec.js',
        repeat: 0,
      },
      {
        key: testKey('chromium', 'a.spec.js', ['y']),
        project: 'chromium',
        file: 'a.spec.js',
        repeat: 0,
      },
      {
        key: testKey('chromium', 'a.spec.js', ['x']),
        project: 'chromium',
        file: 'a.spec.js',
        repeat: 1,
      },
      {
        key: testKey('firefox', 'a.spec.js', ['x']),
        project: 'firefox',
        file: 'a.spec.js',
        repeat: 0,
      },
    ];
    const { units: list, members } = buildUnits(tests, estimator, () => ['setup']);
    assert.strictEqual(list.length, 3);
    assert.deepStrictEqual(members.get(list[0].id), [0, 1]);
    assert.strictEqual(list[0].unknown, 1);
    assert.deepStrictEqual(list[0].deps, ['setup']);
  });

  test('setup and teardown are dependencies, with phases in Playwright order', () => {
    const projects = [
      { name: 'setup', dependencies: [], teardown: 'teardown' },
      { name: 'teardown', dependencies: [] },
      { name: 'chromium', dependencies: ['setup'] },
    ];
    assert.deepStrictEqual([...dependencyProjects(projects, ['chromium'])].sort(), [
      'setup',
      'teardown',
    ]);
    assert.deepStrictEqual(Object.fromEntries(setupPhases(projects, ['chromium'])), {
      setup: 0,
      teardown: 2,
    });
    const costs = setupCosts(
      [{ project: 'setup', key: testKey('setup', 's', ['x']) }],
      createEstimator({})
    );
    assert.deepStrictEqual([...costs], [['setup', 1]]);
  });
});
