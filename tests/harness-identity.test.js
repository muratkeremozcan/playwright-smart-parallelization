/**
 * Leaf and serial group identity on real Playwright. `identity.config.js` has two unnamed
 * projects, tests that a helper registers for two spec files, nested serial suites whose inner
 * suite sits above the outer one, and sibling serial suites built at one call site. A name,
 * file and title key, or a group id from a call site or a line number, collapses or confuses
 * these. `only.config.js` has a focused test with `forbidOnly` off.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkAll, listIntended, qualify } = require('../harness/index.js');
const { runNegativeControl } = require('../harness/negative-control.js');
const { main } = require('../harness/cli.js');
const { requireFixture } = require('./support/fixture.js');

const cwd = requireFixture();
const run = (leaf) => ({ ...leaf, outcome: 'expected' });
const intended = () => listIntended({ cwd, config: 'identity.config.js' });
const where = (leaves, spec) => leaves.filter((leaf) => leaf.specFile === spec);
const kinds = (violations) => [...new Set(violations.map((violation) => violation.kind))];

/** Two shards, the first holding `first`, the second every other leaf. */
function split(leaves, first) {
  const taken = new Set(first.map((leaf) => leaf.key));
  return [
    { index: 1, exitCode: 0, leaves: leaves.filter((l) => taken.has(l.key)).map(run) },
    { index: 2, exitCode: 0, leaves: leaves.filter((l) => !taken.has(l.key)).map(run) },
  ];
}

describe('leaf identity', () => {
  test('two unnamed projects and a shared helper give 24 leaves with unique keys', () => {
    const { leaves } = intended();
    assert.strictEqual(leaves.length, 24);
    assert.strictEqual(new Set(leaves.map((leaf) => leaf.key)).size, 24);
  });

  test('leaves that share a label stay distinct leaves', () => {
    const { leaves } = intended();
    const labels = new Map();
    for (const leaf of leaves) labels.set(leaf.label, (labels.get(leaf.label) || 0) + 1);
    assert.ok(
      [...labels.values()].some((count) => count > 1),
      'the fixture has no label clash'
    );
    assert.strictEqual(new Set(leaves.map((leaf) => leaf.label)).size, 12);
    assert.strictEqual(new Set(leaves.map((leaf) => leaf.testRef)).size, 24);
  });

  test("a helper's tests are told apart by spec file although the call sits in the helper", () => {
    const { leaves } = intended();
    const a = where(leaves, 'shared-a.spec.js').filter((leaf) => leaf.project === '');
    const b = where(leaves, 'shared-b.spec.js').filter((leaf) => leaf.project === '');
    assert.deepStrictEqual([...new Set([...a, ...b].map((leaf) => leaf.file))], ['factory.js']);
    const keys = new Set([...a, ...b].map((leaf) => leaf.key));
    assert.strictEqual(keys.size, a.length + b.length);
  });

  test('running one of two leaves that share a label is not enough', () => {
    const { leaves, dependencies } = intended();
    const clash = leaves.filter((leaf) => leaf.titlePath.at(-1) === 'shared loads');
    assert.ok(clash.length >= 4);
    const dropped = leaves.filter((leaf) => leaf.key !== clash[0].key);
    const shards = [{ index: 1, exitCode: 0, leaves: dropped.map(run) }];
    const missing = checkAll(leaves, dependencies, shards).filter((v) => v.kind === 'missing');
    assert.deepStrictEqual(
      missing.map((violation) => violation.key),
      [clash[0].key]
    );
  });

  test('a clean run of every leaf is accepted', () => {
    const { leaves, dependencies } = intended();
    const shards = [{ index: 1, exitCode: 0, leaves: leaves.map(run) }];
    assert.deepStrictEqual(checkAll(leaves, dependencies, shards), []);
  });
});

describe('serial group identity', () => {
  const groupsOf = (leaves) => new Set(leaves.map((leaf) => leaf.serialGroup));

  test('nested serial suites form one group, the outer suite, in every project', () => {
    const { leaves } = intended();
    const nested = where(leaves, 'nested.spec.js');
    assert.strictEqual(nested.length, 8);
    for (const project of [0, 1]) {
      const ofProject = nested.filter((leaf) => leaf.testRef.startsWith(`${project}|`));
      assert.strictEqual(ofProject.length, 4);
      assert.strictEqual(groupsOf(ofProject).size, 1);
    }
    assert.strictEqual(groupsOf(nested).size, 2);
  });

  test('splitting the outer suite across shards is a serial-split', () => {
    const { leaves, dependencies } = intended();
    const outer = where(leaves, 'nested.spec.js').filter((leaf) => leaf.testRef.startsWith('0|'));
    const first = outer.filter((leaf) => leaf.titlePath.at(-1) === 'outer before');
    const violations = checkAll(leaves, dependencies, split(leaves, first));
    assert.deepStrictEqual(kinds(violations), ['serial-split']);
  });

  test('splitting only the inner suite from its outer suite is a serial-split', () => {
    const { leaves, dependencies } = intended();
    const inner = where(leaves, 'nested.spec.js').filter(
      (leaf) => leaf.testRef.startsWith('0|') && leaf.titlePath.includes('inner')
    );
    const violations = checkAll(leaves, dependencies, split(leaves, inner));
    assert.deepStrictEqual(kinds(violations), ['serial-split']);
  });

  test('sibling suites built at one call site are separate groups', () => {
    const { leaves } = intended();
    const siblings = where(leaves, 'siblings.spec.js').filter((leaf) =>
      leaf.testRef.startsWith('0|')
    );
    assert.strictEqual(siblings.length, 4);
    assert.strictEqual(groupsOf(siblings).size, 2);
  });

  test('siblings on different shards are a valid partition', () => {
    const { leaves, dependencies } = intended();
    const left = where(leaves, 'siblings.spec.js').filter((leaf) => leaf.titlePath[0] === 'left');
    assert.deepStrictEqual(checkAll(leaves, dependencies, split(leaves, left)), []);
  });

  test('splitting one sibling is a serial-split', () => {
    const { leaves, dependencies } = intended();
    const half = where(leaves, 'siblings.spec.js').filter(
      (leaf) => leaf.testRef.startsWith('0|') && leaf.titlePath.join() === 'left,first'
    );
    assert.deepStrictEqual(kinds(checkAll(leaves, dependencies, split(leaves, half))), [
      'serial-split',
    ]);
  });
});

describe('the identity fixture qualifies under native sharding', () => {
  test('2 shards of the real run pass every check', () => {
    const report = qualify({ cwd, config: 'identity.config.js', shards: 2 }, { quiet: true });
    assert.deepStrictEqual(report.violations, []);
    assert.strictEqual(report.ok, true);
  });
});

describe('a focused test', () => {
  const message = /focused test \(\.only\).*executes a subset/s;

  test('is rejected at discovery although forbidOnly is off and Playwright lists both tests', () => {
    assert.throws(() => listIntended({ cwd, config: 'only.config.js' }), message);
  });

  test('is rejected by qualify, the negative control and the CLI', () => {
    const options = { cwd, config: 'only.config.js' };
    assert.throws(() => qualify({ ...options, shards: 2 }, { quiet: true }), message);
    assert.throws(() => runNegativeControl(options), message);
    const written = [];
    const code = main(['--cwd', cwd, '--config', 'only.config.js'], {
      stdout: { write: () => {} },
      stderr: { write: (text) => written.push(text) },
    });
    assert.strictEqual(code, 2);
    assert.match(written.join(''), message);
  });
});
