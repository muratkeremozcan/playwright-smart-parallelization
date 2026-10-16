/** Tests for the command line of run.js and for joining the evidence of separate groups. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parseArgs } = require('../../run');
const { GROUP_NAMES, mergeEvidence } = require('../../proofs');

describe('groups', () => {
  test('are the six that run on separate runners', () => {
    assert.deepStrictEqual(GROUP_NAMES, [
      'coverage',
      'serial',
      'balance',
      'assignment',
      'history',
      'privacy',
    ]);
  });
});

describe('parseArgs', () => {
  test('defaults to every group', () => {
    const options = parseArgs([]);
    assert.strictEqual(options.group, 'all');
    assert.deepStrictEqual(options.merge, []);
    assert.strictEqual(options.requireOsBlock, false);
    assert.strictEqual(path.basename(options.out), 'evidence.json');
  });

  test('accepts each group by name and rejects another', () => {
    for (const name of GROUP_NAMES) assert.strictEqual(parseArgs(['--group', name]).group, name);
    assert.throws(() => parseArgs(['--group', 'other']), /--group needs one of/);
  });

  test('reads merge files up to the next flag', () => {
    const options = parseArgs(['--merge', 'a.json', 'b.json', '--out', 'c.json']);
    assert.deepStrictEqual(options.merge, [path.resolve('a.json'), path.resolve('b.json')]);
  });
});

describe('mergeEvidence', () => {
  const versions = { engine: 'e@1', playwright: '1', node: 'v1', platform: 'x' };
  const part = (group, rows, extra = {}) => ({
    group,
    versions,
    rows,
    durationMs: 10,
    balance: null,
    footprint: null,
    ...extra,
  });
  const row = (id, proof, status) => ({ id, proof, status, subject: 'engine' });

  test('rolls the rows of every group up into the proofs', () => {
    const merged = mergeEvidence([
      part('coverage', [row('1.a', 1, 'pass')]),
      part('serial', [row('2.a', 2, 'fail')]),
    ]);
    assert.strictEqual(merged.proofs.find((proof) => proof.number === 1).status, 'pass');
    assert.strictEqual(merged.proofs.find((proof) => proof.number === 2).status, 'fail');
  });

  test('takes balance and footprint from the group that measured them', () => {
    const merged = mergeEvidence([
      part('balance', [], { balance: [{ shards: 2 }] }),
      part('privacy', [], { footprint: { install: {} } }),
    ]);
    assert.deepStrictEqual(merged.balance, [{ shards: 2 }]);
    assert.deepStrictEqual(merged.footprint, { install: {} });
  });

  test('refuses a repeated row, other versions and a measurement from two groups', () => {
    assert.throws(
      () => mergeEvidence([part('a', [row('1.a', 1, 'pass')]), part('b', [row('1.a', 1, 'pass')])]),
      /appears in two parts/
    );
    assert.throws(
      () =>
        mergeEvidence([part('a', []), { ...part('b', []), versions: { ...versions, node: 'v2' } }]),
      /different versions/
    );
    assert.throws(
      () => mergeEvidence([part('a', [], { balance: [{}] }), part('b', [], { balance: [{}] })]),
      /balance appears in two parts/
    );
  });
});
