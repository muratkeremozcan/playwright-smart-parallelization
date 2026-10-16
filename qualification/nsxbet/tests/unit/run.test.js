/** Tests for the command line of run.js and for joining the evidence of separate groups. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parseArgs } = require('../../run');
const { GROUP_NAMES, mergeEvidence } = require('../../proofs');

describe('parseArgs', () => {
  test('defaults to every group', () => {
    const options = parseArgs([]);
    assert.strictEqual(options.group, 'all');
    assert.deepStrictEqual(options.merge, []);
    assert.strictEqual(options.requireOsBlock, false);
  });

  test('accepts each group by name and rejects another', () => {
    for (const name of GROUP_NAMES) assert.strictEqual(parseArgs(['--group', name]).group, name);
    assert.throws(() => parseArgs(['--group', 'other']), /--group needs one of/);
    assert.throws(() => parseArgs(['--group']), /--group needs one of/);
  });

  test('reads merge files up to the next flag', () => {
    const options = parseArgs(['--merge', 'a.json', 'b.json', '--out', 'c.json']);
    assert.deepStrictEqual(options.merge, [path.resolve('a.json'), path.resolve('b.json')]);
    assert.strictEqual(options.out, path.resolve('c.json'));
  });

  test('rejects --merge without files, a missing --out value and unknown flags', () => {
    assert.throws(() => parseArgs(['--merge']), /--merge needs files/);
    assert.throws(() => parseArgs(['--out']), /--out needs a value/);
    assert.throws(() => parseArgs(['--nope']), /unknown flag/);
  });

  test('records --require-os-block', () => {
    assert.strictEqual(parseArgs(['--require-os-block']).requireOsBlock, true);
  });
});

describe('mergeEvidence', () => {
  const versions = { engine: 'pkg@1', playwright: '2', node: 'v3', platform: 'x' };
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

  test('joins rows, rolls the proofs up again and takes measurements from their group', () => {
    const merged = mergeEvidence([
      part('serial', [row('2.a', 2, 'fail')], { balance: [{ shards: 2 }], durationMs: 30 }),
      part('privacy', [row('net.a', 'net', 'pass')], {
        footprint: { install: {} },
        durationMs: 20,
      }),
    ]);
    assert.deepStrictEqual(
      merged.rows.map((r) => r.id),
      ['2.a', 'net.a']
    );
    assert.strictEqual(merged.proofs.find((p) => p.number === 2).status, 'fail');
    assert.deepStrictEqual(merged.balance, [{ shards: 2 }]);
    assert.deepStrictEqual(merged.footprint, { install: {} });
    assert.strictEqual(merged.durationMs, 30);
    assert.deepStrictEqual(merged.legsMs, { serial: 30, privacy: 20 });
  });

  test('rejects a repeated row, different versions, repeated measurements and no parts', () => {
    assert.throws(
      () => mergeEvidence([part('a', [row('1.a', 1, 'pass')]), part('b', [row('1.a', 1, 'pass')])]),
      /appears in two parts/
    );
    assert.throws(
      () =>
        mergeEvidence([part('a', []), { ...part('b', []), versions: { ...versions, node: 'v4' } }]),
      /different versions/
    );
    assert.throws(
      () => mergeEvidence([part('a', [], { balance: [1] }), part('b', [], { balance: [2] })]),
      /balance appears in two parts/
    );
    assert.throws(() => mergeEvidence([]), /nothing to merge/);
  });
});
