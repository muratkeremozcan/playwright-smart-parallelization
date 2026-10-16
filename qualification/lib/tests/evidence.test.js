/** Tests for the verdict rule and the roll-up of rows into proof results. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { proofStatus, verdictFor } = require('../evidence');
const nsx = require('../../nsxbet/expected');
const flakiness = require('../../flakiness/expected');

const all = (status) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, status]));

describe('verdictFor', () => {
  test('an engine that passes every proof qualifies', () => {
    assert.strictEqual(verdictFor(all('pass')), 'qualifies');
  });

  test('a failed proof other than 1 and 2 leaves gaps to name', () => {
    for (const number of [3, 4, 5, 6, 7, 8]) {
      assert.strictEqual(
        verdictFor({ ...all('pass'), [number]: 'fail' }),
        'qualifies with named gaps',
        `proof ${number}`
      );
    }
  });

  test('a failed exactly-once or serial proof disqualifies, whatever else passes', () => {
    assert.strictEqual(verdictFor({ ...all('pass'), 1: 'fail' }), 'does not qualify');
    assert.strictEqual(verdictFor({ ...all('pass'), 2: 'fail' }), 'does not qualify');
    assert.strictEqual(
      verdictFor({ ...all('fail'), 1: 'pass', 2: 'pass' }),
      'qualifies with named gaps'
    );
  });
});

describe('the expected verdicts', () => {
  test('follow from the expected proof results of each engine', () => {
    assert.strictEqual(nsx.VERDICT, 'does not qualify');
    assert.strictEqual(flakiness.VERDICT, 'qualifies with named gaps');
  });
});

describe('proofStatus', () => {
  const row = (proof, status, subject) => ({ proof, status, subject });

  test('fails when any engine row of the proof fails', () => {
    assert.strictEqual(proofStatus([row(1, 'pass'), row(1, 'fail')], 1), 'fail');
  });

  test('ignores rows about glue code and about Playwright', () => {
    assert.strictEqual(
      proofStatus([row(1, 'pass'), row(1, 'fail', 'integration'), row(1, 'fail', 'playwright')], 1),
      'pass'
    );
  });

  test('ignores rows of other proofs', () => {
    assert.strictEqual(proofStatus([row(2, 'fail')], 1), 'pass');
  });
});
