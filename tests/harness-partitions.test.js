/** Tests for partition builders and the negative control's broken assignments. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const leaves = require('../harness/leaves.js');
const checks = require('../harness/checks.js');
const { nativePartition, testListPartition } = require('../harness/partitions.js');
const { buildControls, buildSelectionScenarios } = require('../harness/negative-control.js');
const { parseArgs } = require('../harness/cli.js');
const { listFixture } = require('./support/fixture.js');

// The real fixture, listed by the harness reporter with --repeat-each=2.
const { leaves: intended, dependencies } = listFixture({ repeatEach: 2 });

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('nativePartition', () => {
  test('builds --shard=i/n arguments', () => {
    assert.deepStrictEqual(nativePartition(3), [
      { args: ['--shard=1/3'] },
      { args: ['--shard=2/3'] },
      { args: ['--shard=3/3'] },
    ]);
  });

  test('rejects a non-positive shard count', () => {
    assert.throws(() => nativePartition(0), /positive integer/);
  });
});

describe('testListPartition', () => {
  function build(assignment) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-partition-test-'));
    tempDirs.push(dir);
    return { dir, shards: testListPartition(assignment, intended, dir) };
  }

  test('writes one list file per shard in the --list text form, once per test', () => {
    const keys = intended
      .filter((leaf) => leaf.project === 'chromium' && leaf.file === 'catalog.spec.js')
      .map((leaf) => leaf.key);
    const { shards } = build([keys, []]);
    assert.strictEqual(shards.length, 2);
    assert.strictEqual(shards[0].args[0], '--test-list');
    const lines = fs.readFileSync(shards[0].args[1], 'utf8').trim().split('\n');
    assert.deepStrictEqual(lines, [
      '[chromium] › catalog.spec.js:7:3 › catalog › loads the page',
      '[chromium] › catalog.spec.js:12:3 › catalog › filters products by category',
      '[chromium] › catalog.spec.js:17:3 › catalog › sorts products by price',
    ]);
  });

  test('leaves dependency leaves out, since Playwright adds them', () => {
    const setupKey = intended.find((leaf) => leaf.project === 'setup').key;
    const { shards } = build([[setupKey]]);
    assert.strictEqual(fs.readFileSync(shards[0].args[1], 'utf8').trim(), '');
  });

  test('rejects an unknown leaf key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-partition-test-'));
    tempDirs.push(dir);
    assert.throws(() => testListPartition([['nope']], intended, dir), /unknown leaf key/);
  });
});

describe('buildControls', () => {
  const controls = buildControls(intended);
  const primary = intended.filter((leaf) => !leaf.dependency);

  function executed(assignment) {
    return assignment.map((keys, index) => ({
      index: index + 1,
      exitCode: 0,
      leaves: [
        ...intended.filter((leaf) => leaf.dependency),
        ...keys.map((key) => intended.find((leaf) => leaf.key === key)),
      ],
    }));
  }

  test('builds the clean control first, then the four broken ones with their kinds', () => {
    assert.deepStrictEqual(
      controls.map((control) => control.expected),
      ['none', 'missing', 'duplicate', 'serial-split', 'not-executed']
    );
  });

  test('the skipped control assigns the clean partition and skips every test through the env', () => {
    assert.deepStrictEqual(controls[4].assignment, controls[0].assignment);
    assert.deepStrictEqual(controls[4].env, { PSP_FIXTURE_SKIP_ALL: '1' });
    for (const control of controls.slice(0, 4)) assert.strictEqual(control.env, undefined);
  });

  test('the skipped control raises not-executed when every leaf it runs skipped', () => {
    const shards = executed(controls[4].assignment).map((shard) => ({
      ...shard,
      leaves: shard.leaves.map((entry) => ({ ...entry, outcome: 'skipped' })),
    }));
    const found = checks.checkExecution(intended, shards);
    assert.ok(found.length > 0);
    assert.deepStrictEqual(
      new Set(found.map((violation) => violation.kind)),
      new Set(['not-executed'])
    );
  });

  test('the clean control passes every check when its shards run as assigned', () => {
    const shards = executed(controls[0].assignment);
    assert.deepStrictEqual(checks.checkCoverage(intended, shards), []);
    assert.deepStrictEqual(checks.checkSerialGroups(intended, shards), []);
  });

  for (const [position, kind] of [
    [1, 'missing'],
    [2, 'duplicate'],
    [3, 'serial-split'],
  ]) {
    test(`the ${kind} control raises that violation when its shards run as assigned`, () => {
      const shards = executed(controls[position].assignment);
      const found = [
        ...checks.checkCoverage(intended, shards),
        ...checks.checkSerialGroups(intended, shards),
      ].map((violation) => violation.kind);
      assert.ok(found.includes(kind), `${kind} not in ${found}`);
    });
  }

  test('the serial control breaks no other correctness property than the serial group', () => {
    const shards = executed(controls[3].assignment);
    assert.deepStrictEqual(checks.checkCoverage(intended, shards), []);
  });

  test('a clean assignment of the same units passes every check', () => {
    const { buildUnits, cleanAssignment } = require('../harness/negative-control.js');
    const shards = executed(cleanAssignment(buildUnits(intended)));
    assert.deepStrictEqual(checks.checkCoverage(intended, shards), []);
    assert.deepStrictEqual(checks.checkSerialGroups(intended, shards), []);
    assert.strictEqual(shards.flatMap((shard) => shard.leaves).length - 4, primary.length);
  });

  test('refuses a suite without a serial group', () => {
    const plainOnly = intended.filter((leaf) => !leaf.serialGroup);
    assert.throws(() => buildControls(plainOnly), /serial group/);
  });
});

describe('buildSelectionScenarios', () => {
  const scenarios = buildSelectionScenarios(dependencies, intended);
  const setupKey = intended.find((leaf) => leaf.project === 'setup').key;
  const nativeShards = nativePartition(2);

  // The listing a scenario's selection yields: setup (and teardown) and, when chromium is selected
  // and keeps a test, chromium too.
  const listingOf = (projects, map = dependencies) => ({
    leaves: leaves.classify(
      intended.filter((leaf) => projects.includes(leaf.project)),
      map
    ),
  });

  test('selects the dependency project that has a dependency of its own, four ways', () => {
    assert.deepStrictEqual(
      scenarios.map((scenario) => scenario.forward),
      [
        ['--project=setup'],
        ['--project', 'setup', 'chromium', '--grep', 'prepare the environment'],
        ['--grep', 'prepare the environment'],
        ['--no-deps', '--project=setup', '--project=teardown'],
      ]
    );
  });

  test('pairs each scenario with a clean native run and a broken run that flags the setup leaf', () => {
    const selected = listingOf(['setup', 'teardown']);
    const filtered = listingOf(['setup', 'teardown']);
    const noDeps = Object.fromEntries(Object.keys(dependencies).map((name) => [name, []]));
    const flat = listingOf(['setup', 'teardown'], noDeps);
    const summary = (scenario, listing) =>
      scenario
        .controls(listing)
        .map((control) => [
          control.expected,
          control.forward,
          control.partition,
          control.flagged || null,
        ]);
    assert.deepStrictEqual(summary(scenarios[0], selected), [
      ['none', scenarios[0].forward, nativeShards, null],
      ['missing', [], [{ args: ['--project=teardown'] }], [setupKey]],
    ]);
    assert.deepStrictEqual(summary(scenarios[1], filtered), [
      ['none', scenarios[1].forward, nativeShards, null],
      ['missing', [], [{ args: ['--project=teardown'] }], [setupKey]],
    ]);
    assert.deepStrictEqual(summary(scenarios[2], filtered), [
      ['none', scenarios[2].forward, nativeShards, null],
      ['missing', [], [{ args: ['--project=teardown'] }], [setupKey]],
    ]);
    assert.deepStrictEqual(summary(scenarios[3], flat), [
      ['none', scenarios[3].forward, nativeShards, null],
      [
        'duplicate',
        ['--no-deps'],
        [{ args: ['--project=setup'] }, { args: ['--project=setup'] }],
        [setupKey],
      ],
    ]);
  });

  test('the broken controls are caught only once the selected project has primary leaves', () => {
    const missingKeys = (leavesOfRun, shards) =>
      checks
        .checkCoverage(leavesOfRun, shards)
        .filter((violation) => violation.kind === 'missing')
        .map((violation) => violation.key);
    const teardownOnly = [
      { index: 1, exitCode: 0, leaves: intended.filter((leaf) => leaf.project === 'teardown') },
    ];
    const selected = leaves.classify(
      intended.filter((leaf) => ['setup', 'teardown'].includes(leaf.project)),
      dependencies
    );
    assert.ok(missingKeys(selected, teardownOnly).includes(setupKey));
    assert.ok(!missingKeys(intended, teardownOnly).includes(setupKey));
  });

  test('refuses a filter that also selects the dependent project', () => {
    assert.throws(
      () => scenarios[1].controls(listingOf(['setup', 'chromium', 'teardown'])),
      /also selects chromium/
    );
  });

  test('refuses a suite without a dependency project that has a dependency', () => {
    assert.throws(
      () => buildSelectionScenarios({ setup: [], teardown: [], chromium: ['setup'] }, intended),
      /dependency project/
    );
  });

  test('refuses a suite without a test in the setup project', () => {
    const withoutSetup = intended.filter((leaf) => leaf.project !== 'setup');
    assert.throws(() => buildSelectionScenarios(dependencies, withoutSetup), /a setup test/);
  });
});

describe('parseArgs', () => {
  test('reads flags and forwards everything after the separator', () => {
    const options = parseArgs([
      '--cwd',
      'fixtures/consumer',
      '--shards',
      '3',
      '--repeat-each',
      '2',
      '--workers',
      '4',
      '--report',
      'out.json',
      '--negative-control',
      '--',
      '--grep',
      'cart',
    ]);
    assert.strictEqual(path.basename(options.cwd), 'consumer');
    assert.deepStrictEqual(
      [options.shards, options.repeatEach, options.workers, options.report],
      [3, 2, 4, 'out.json']
    );
    assert.strictEqual(options.negativeControl, true);
    assert.deepStrictEqual(options.forward, ['--grep', 'cart']);
  });

  test('defaults to two shards, one worker, no repeats', () => {
    const options = parseArgs([]);
    assert.deepStrictEqual(
      [options.shards, options.repeatEach, options.workers, options.negativeControl],
      [2, 1, 1, false]
    );
  });

  test('rejects an unknown flag and a bad number', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown flag/);
    assert.throws(() => parseArgs(['--shards', '0']), /positive integer/);
    assert.throws(() => parseArgs(['--shards']), /needs a value/);
  });
});
