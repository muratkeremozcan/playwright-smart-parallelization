/**
 * Tests that a violation in a run decides the row that scores the run. A leaf that skipped or never
 * ran (`not-executed`) must fail every row, however clean the rest of the run is.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { coverageRow, dependencyRow } = require('../../../lib/scoring');
const { classifyListing } = require('../../scenarios/assignment');
const { PROBES, judge, program, spawnsOf, unexpectedPrograms } = require('../../scenarios/network');
const { outcomesRow, serialRow, shardMix } = require('../../scenarios/serial');

const run = (kinds = {}, groups = []) => ({
  summary: { kinds, groups, shards: [{ index: 1, exitCode: 0 }] },
  report: { dependencyExecutions: {} },
  partition: [],
});

describe('a skipped leaf fails every row that scores the run', () => {
  const skipped = run({ 'not-executed': 56 });

  test('coverage, serial and dependency rows', () => {
    assert.strictEqual(coverageRow('c', 1, 't', skipped).status, 'fail');
    assert.strictEqual(serialRow('s', 't', skipped).status, 'fail');
    assert.strictEqual(dependencyRow([skipped]).status, 'fail');
  });

  test('a clean run passes them', () => {
    assert.strictEqual(serialRow('s', 't', run()).status, 'pass');
  });

  test('a split serial group and a failed shard fail the serial row', () => {
    assert.strictEqual(serialRow('s', 't', run({}, ['g'])).status, 'fail');
    assert.strictEqual(serialRow('s', 't', run({ 'shard-failed': 1 })).status, 'fail');
  });
});

describe('classifyListing', () => {
  const failed = { exitCode: 1, leaves: null };
  const listed = { exitCode: 0, leaves: [{ key: 'a' }] };

  test('every shard failing before it lists a test fails before any test', () => {
    assert.strictEqual(classifyListing([failed, failed], {}), 'fails before any test');
  });

  test('every shard listing with no coverage violation is a complete plan', () => {
    assert.strictEqual(classifyListing([listed, listed], {}), 'complete plan');
  });

  test('a split with coverage violations is incomplete, silent or not', () => {
    assert.strictEqual(classifyListing([listed, listed], { duplicate: 1 }), 'incomplete');
  });

  test('one shard failing while another lists is incomplete', () => {
    assert.strictEqual(classifyListing([failed, listed], { missing: 3 }), 'incomplete');
  });

  test('a shard that exits non-zero after listing tests is not a failure before any test', () => {
    assert.strictEqual(
      classifyListing([{ exitCode: 1, leaves: [{ key: 'a' }] }, failed], {}),
      'incomplete'
    );
  });
});

describe('outcomesRow', () => {
  const serialLeaf = (key) => ({ key, serialGroup: `g-${key}`, dependency: false });
  const shard = (leaves) => ({ leaves });
  const make = (leaves, shards, kinds = {}) => ({
    listing: { leaves },
    raw: shards,
    summary: { kinds },
  });
  const listing = [serialLeaf('a'), serialLeaf('b'), { key: 'c', dependency: false }];
  const native = make(listing, [
    shard([
      { key: 'a', outcome: 'flaky', attempts: 2 },
      { key: 'b', outcome: 'expected', attempts: 1 },
    ]),
  ]);

  test('passes when serial leaves end the same, whatever shard ran them', () => {
    const balanced = make(listing, [
      shard([{ key: 'b', outcome: 'expected', attempts: 1 }]),
      shard([{ key: 'a', outcome: 'flaky', attempts: 2 }]),
    ]);
    assert.strictEqual(outcomesRow(native, balanced).status, 'pass');
  });

  test('fails when an outcome or the attempts differ', () => {
    const balanced = make(listing, [
      shard([
        { key: 'a', outcome: 'flaky', attempts: 3 },
        { key: 'b', outcome: 'expected', attempts: 1 },
      ]),
    ]);
    const row = outcomesRow(native, balanced);
    assert.strictEqual(row.status, 'fail');
    assert.deepStrictEqual(row.evidence.differing, ['a']);
  });

  test('fails when no serial leaf retried, so the comparison proves nothing about retries', () => {
    const quiet = make(listing, [
      shard([
        { key: 'a', outcome: 'expected', attempts: 1 },
        { key: 'b', outcome: 'expected', attempts: 1 },
      ]),
    ]);
    assert.strictEqual(outcomesRow(quiet, quiet).status, 'fail');
  });

  test('fails when both runs skipped the same leaves', () => {
    const skipped = (kinds) =>
      make(
        listing,
        [
          shard([
            { key: 'a', outcome: 'flaky', attempts: 2 },
            { key: 'b', outcome: 'expected', attempts: 1 },
          ]),
        ],
        kinds
      );
    const row = outcomesRow(skipped({ 'not-executed': 2 }), skipped({ 'not-executed': 2 }));
    assert.strictEqual(row.status, 'fail');
    assert.deepStrictEqual(row.evidence.coverageViolations, {
      native: { 'not-executed': 2 },
      balanced: { 'not-executed': 2 },
    });
  });

  test('fails when a serial leaf did not run', () => {
    const missing = make(listing, [shard([{ key: 'a', outcome: 'flaky', attempts: 2 }])]);
    assert.strictEqual(outcomesRow(native, missing).status, 'fail');
  });
});

describe('shardMix', () => {
  test('counts setup and teardown, dependent and independent leaves per shard', () => {
    const leaf = (project) => ({ project });
    const mix = shardMix({
      raw: [
        { leaves: [leaf('setup'), leaf('teardown'), leaf('chromium'), leaf('chromium')] },
        { leaves: [leaf('api')] },
        { leaves: null },
      ],
    });
    assert.deepStrictEqual(mix, [
      { dependencyLeaves: 2, dependentLeaves: 2, independentLeaves: 0 },
      { dependencyLeaves: 0, dependentLeaves: 0, independentLeaves: 1 },
      { dependencyLeaves: 0, dependentLeaves: 0, independentLeaves: 0 },
    ]);
  });
});

describe('the spawn check of the network audit', () => {
  const spawn = (target) => ({ kind: 'spawn', target, pid: 1 });
  const worker = '/p/node_modules/playwright/lib/worker/workerProcessEntry.js';

  test('names a program by its command, without directory or arguments', () => {
    assert.strictEqual(program('/usr/bin/git rev-parse HEAD'), 'git');
    assert.strictEqual(program('sw_vers -productVersion'), 'sw_vers');
  });

  test('counts programs by name and Playwright workers apart', () => {
    assert.deepStrictEqual(
      spawnsOf([spawn('git'), spawn('git'), spawn('uname -m'), spawn(worker), { kind: 'connect' }]),
      { programs: { git: 2, uname: 1 }, workers: 1 }
    );
  });

  test('only the programs the package source starts are expected', () => {
    assert.deepStrictEqual([...PROBES].sort(), ['git', 'sw_vers', 'uname', 'vm_stat']);
    assert.deepStrictEqual(unexpectedPrograms({ programs: { git: 1, curl: 2 }, workers: 3 }), [
      'curl',
    ]);
  });

  test('a clean step passes', () => {
    assert.strictEqual(judge([spawn('git'), spawn(worker)], [0, 0]).status, 'pass');
  });

  test('a connection attempt fails the step', () => {
    const entries = [{ kind: 'connect', target: 'vendor.invalid:443', pid: 1 }];
    const { status, evidence } = judge(entries, [0]);
    assert.strictEqual(status, 'fail');
    assert.deepStrictEqual(evidence.attemptTargets, ['vendor.invalid:443']);
  });

  test('a spawned curl fails the step', () => {
    const { status, evidence } = judge([spawn('curl -s http://vendor.invalid/')], [0]);
    assert.strictEqual(status, 'fail');
    assert.deepStrictEqual(evidence.unexpectedPrograms, ['curl']);
  });

  test('a non-zero exit fails the step', () => {
    assert.strictEqual(judge([], [0, 1]).status, 'fail');
  });
});
