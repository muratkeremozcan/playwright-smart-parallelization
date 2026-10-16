/**
 * Project names are user strings. A project named `__proto__` is also an Object.prototype accessor,
 * so any plain object keyed by project name drops it. The fixture config `proto.config.js` renames
 * the chromium project to `__proto__`; a run that drops every test of it must still be rejected.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkAll } = require('../harness/index.js');
const { listFixture } = require('./support/fixture.js');

const NAME = '__proto__';
const listed = () => listFixture({ config: 'proto.config.js' });
const run = (leaf) => ({ ...leaf, outcome: 'expected' });

describe('a project named __proto__', () => {
  test('is a top-level project with primary leaves', () => {
    const roles = new Map();
    for (const leaf of listed().leaves) roles.set(leaf.project, leaf.dependency);
    assert.strictEqual(roles.get(NAME), false);
    assert.strictEqual(roles.get('firefox'), false);
    assert.strictEqual(roles.get('setup'), true);
  });

  test('keeps its dependencies in the dependency map', () => {
    assert.deepStrictEqual(listed().dependencies[NAME], ['setup', 'teardown']);
  });

  test('accepts the clean partition', () => {
    const intended = listed();
    const shards = [
      { index: 1, exitCode: 0, leaves: intended.leaves.map(run) },
      { index: 2, exitCode: 0, leaves: [] },
    ];
    assert.deepStrictEqual(checkAll(intended.leaves, intended.dependencies, shards), []);
  });

  test('rejects a partition that drops every test of it', () => {
    const intended = listed();
    const kept = intended.leaves.filter((leaf) => leaf.project !== NAME);
    const shards = [
      { index: 1, exitCode: 0, leaves: kept.map(run) },
      { index: 2, exitCode: 0, leaves: [] },
    ];
    const missing = checkAll(intended.leaves, intended.dependencies, shards).filter(
      (violation) => violation.kind === 'missing'
    );
    assert.strictEqual(missing.length, intended.leaves.filter((l) => l.project === NAME).length);
    assert.ok(missing.length > 0);
  });
});
