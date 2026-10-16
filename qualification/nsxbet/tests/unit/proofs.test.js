/** Tests for how rows roll up into proof results. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EXTRAS, PROOFS, proofStatus, summarizeExtras, summarizeProofs } = require('../../proofs');

const row = (id, proof, status, subject) => ({ id, proof, status, subject });

describe('proofStatus', () => {
  test('is pass when every row of the proof passes', () => {
    assert.strictEqual(proofStatus([row('a', 1, 'pass'), row('b', 1, 'pass')], 1), 'pass');
  });

  test('is fail when any row of the proof fails', () => {
    assert.strictEqual(proofStatus([row('a', 1, 'pass'), row('b', 1, 'fail')], 1), 'fail');
  });

  test('ignores rows of other proofs and skipped rows', () => {
    const rows = [row('a', 2, 'fail'), row('b', 1, 'skipped'), row('c', 1, 'pass')];
    assert.strictEqual(proofStatus(rows, 1), 'pass');
  });

  test('ignores integration and Playwright rows, which do not describe the engine', () => {
    const rows = [
      row('a', 2, 'fail', 'integration'),
      row('b', 2, 'fail', 'playwright'),
      row('c', 2, 'pass'),
    ];
    assert.strictEqual(proofStatus(rows, 2), 'pass');
  });
});

describe('summarizeProofs', () => {
  test('lists the eight proofs in order with their results', () => {
    const summary = summarizeProofs([row('a', 3, 'fail')]);
    assert.deepStrictEqual(
      summary.map((proof) => proof.number),
      [1, 2, 3, 4, 5, 6, 7, 8]
    );
    assert.strictEqual(summary.find((proof) => proof.number === 3).status, 'fail');
    assert.strictEqual(summary.find((proof) => proof.number === 4).status, 'pass');
    assert.strictEqual(PROOFS.length, 8);
  });
});

describe('summarizeExtras', () => {
  test('rolls the rows of each extra case up on their own', () => {
    const summary = summarizeExtras([
      row('x1.a', 'x1', 'fail'),
      row('x2.a', 'x2', 'pass'),
      row('5.a', 5, 'fail'),
    ]);
    assert.deepStrictEqual(
      summary.map((extra) => [extra.id, extra.status]),
      [
        ['x1', 'fail'],
        ['x2', 'pass'],
      ]
    );
    assert.strictEqual(EXTRAS.length, 2);
  });
});
