/**
 * Leaf and serial group identity on real Playwright. `identity.config.js` has two projects over the
 * same specs, tests that a helper registers for two spec files, nested serial suites whose inner
 * suite sits above the outer one, and sibling serial suites built at one call site. A name,
 * file and title key, or a group id from a call site or a line number, collapses or confuses
 * these. `only.config.js` has a focused test with `forbidOnly` off.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkAll, listIntended, qualify, runPartition } = require('../harness/index.js');
const { listLine } = require('../harness/leaves.js');
const { testListPartition } = require('../harness/partitions.js');
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
  test('two projects and a shared helper give 24 leaves with unique keys', () => {
    const { leaves } = intended();
    assert.strictEqual(leaves.length, 24);
    assert.strictEqual(new Set(leaves.map((leaf) => leaf.key)).size, 24);
  });

  test('a key from project, call location, title and repeat would collapse leaves', () => {
    const { leaves } = intended();
    const naive = leaves.map(
      (leaf) => `${leaf.project}|${leaf.file}|${leaf.titlePath.join(' › ')}|#${leaf.repeatIndex}`
    );
    assert.ok(new Set(naive).size < leaves.length, 'the fixture has no collision');
    assert.strictEqual(new Set(leaves.map((leaf) => leaf.label)).size, 24);
  });

  test("a helper's tests are told apart by spec file although the call sits in the helper", () => {
    const { leaves } = intended();
    const a = where(leaves, 'shared-a.spec.js').filter((leaf) => leaf.project === 'one');
    const b = where(leaves, 'shared-b.spec.js').filter((leaf) => leaf.project === 'one');
    assert.deepStrictEqual([...new Set([...a, ...b].map((leaf) => leaf.file))], ['factory.js']);
    const keys = new Set([...a, ...b].map((leaf) => leaf.key));
    assert.strictEqual(keys.size, a.length + b.length);
  });

  test('running one of two leaves the helper registers is not enough', () => {
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
    for (const project of ['one', 'two']) {
      const ofProject = nested.filter((leaf) => leaf.testRef.startsWith(`${project}|`));
      assert.strictEqual(ofProject.length, 4);
      assert.strictEqual(groupsOf(ofProject).size, 1);
    }
    assert.strictEqual(groupsOf(nested).size, 2);
  });

  test('splitting the outer suite across shards is a serial-split', () => {
    const { leaves, dependencies } = intended();
    const outer = where(leaves, 'nested.spec.js').filter((leaf) => leaf.testRef.startsWith('one|'));
    const first = outer.filter((leaf) => leaf.titlePath.at(-1) === 'outer before');
    const violations = checkAll(leaves, dependencies, split(leaves, first));
    assert.deepStrictEqual(kinds(violations), ['serial-split']);
  });

  test('splitting only the inner suite from its outer suite is a serial-split', () => {
    const { leaves, dependencies } = intended();
    const inner = where(leaves, 'nested.spec.js').filter(
      (leaf) => leaf.testRef.startsWith('one|') && leaf.titlePath.includes('inner')
    );
    const violations = checkAll(leaves, dependencies, split(leaves, inner));
    assert.deepStrictEqual(kinds(violations), ['serial-split']);
  });

  test('sibling suites built at one call site are separate groups', () => {
    const { leaves } = intended();
    const siblings = where(leaves, 'siblings.spec.js').filter((leaf) =>
      leaf.testRef.startsWith('one|')
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
      (leaf) => leaf.testRef.startsWith('one|') && leaf.titlePath.join() === 'left,first'
    );
    assert.deepStrictEqual(kinds(checkAll(leaves, dependencies, split(leaves, half))), [
      'serial-split',
    ]);
  });
});

describe("explicit test-list partitions of a helper's tests", () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-identity-'));
    dirs.push(dir);
    return dir;
  };

  const bySpec = (leaves, specs) =>
    leaves.filter((leaf) => specs.includes(leaf.specFile)).map((leaf) => leaf.key);

  const NOT_SHARED = ['nested.spec.js', 'siblings.spec.js'];

  test('execute every leaf exactly once when the specs that build suites are split', () => {
    // siblings.spec.js builds its suites in the helper, so its call location is the helper file.
    const { leaves, dependencies } = intended();
    const selectable = leaves.filter((leaf) => NOT_SHARED.includes(leaf.specFile));
    const assignment = [
      bySpec(selectable, ['nested.spec.js']),
      bySpec(selectable, ['siblings.spec.js']),
    ];
    const partition = testListPartition(assignment, selectable, tempDir());
    const shards = runPartition({ cwd, config: 'identity.config.js' }, partition);
    assert.deepStrictEqual(
      shards.map((shard) => shard.leaves.length),
      [8, 8]
    );
    assert.deepStrictEqual(checkAll(selectable, dependencies, shards), []);
  });

  test('split one helper-built spec by suite: each shard runs only its suite', () => {
    const { leaves, dependencies } = intended();
    const selectable = leaves.filter((leaf) => leaf.specFile === 'siblings.spec.js');
    const left = selectable.filter((leaf) => leaf.titlePath[0] === 'left').map((l) => l.key);
    const right = selectable.filter((leaf) => leaf.titlePath[0] === 'right').map((l) => l.key);
    const partition = testListPartition([left, right], selectable, tempDir());
    const shards = runPartition({ cwd, config: 'identity.config.js' }, partition);
    assert.deepStrictEqual(checkAll(selectable, dependencies, shards), []);
  });

  test("refuse the helper's tests that two specs register, which no line tells apart", () => {
    const { leaves } = intended();
    assert.throws(
      () => testListPartition([leaves.map((leaf) => leaf.key)], leaves, tempDir()),
      /shared-a\.spec\.js.* and .*shared-b\.spec\.js.*no line tells them apart/s
    );
    assert.throws(() => runNegativeControl({ cwd, config: 'identity.config.js' }), /no line tells/);
  });

  test("run nothing of the helper's tests when only the helper is selected", () => {
    const { leaves, dependencies } = intended();
    const helper = leaves.filter((leaf) => leaf.file === 'factory.js');
    assert.ok(helper.length > 0);
    const dir = tempDir();
    const file = path.join(dir, 'helper-only.txt');
    fs.writeFileSync(file, `${helper.map(listLine).join('\n')}\n`);
    const shards = runPartition({ cwd, config: 'identity.config.js' }, [
      { args: ['--test-list', file] },
    ]);
    assert.strictEqual(shards[0].leaves.length, 0);
    const missing = checkAll(leaves, dependencies, shards).filter((v) => v.kind === 'missing');
    assert.strictEqual(missing.length, leaves.length);
  });
});

describe('a config with testDir only inside its projects', () => {
  // The config rootDir is the fixture directory, so a list line names a file relative to it.
  const config = 'project-testdir.config.js';
  const dirs = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('names each file relative to the rootDir, not to the project testDir', () => {
    const { leaves } = listIntended({ cwd, config });
    assert.strictEqual(leaves.length, 9);
    for (const leaf of leaves) {
      assert.ok(leaf.file.includes('-tests/'), `${leaf.file} is not relative to the rootDir`);
      assert.ok(leaf.specFile.includes('-tests/'));
    }
  });

  test('an explicit test-list partition runs every leaf exactly once', () => {
    const { leaves, dependencies } = listIntended({ cwd, config });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-rootdir-'));
    dirs.push(dir);
    const keys = (project) => leaves.filter((leaf) => leaf.project === project).map((l) => l.key);
    const partition = testListPartition([keys('p'), keys('q')], leaves, dir);
    const shards = runPartition({ cwd, config }, partition);
    assert.deepStrictEqual(
      shards.map((shard) => shard.leaves.length),
      [8, 1]
    );
    assert.deepStrictEqual(checkAll(leaves, dependencies, shards), []);
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
