'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { median, rangesOverlap, summarize } = require('../stats');

test('median of an odd and an even count', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]));
});

test('summarize reports median, extremes and spread over the median', () => {
  assert.deepEqual(summarize([8, 10, 12]), { n: 3, median: 10, min: 8, max: 12, spread: 0.4 });
  assert.equal(summarize([0, 0]).spread, 0);
});

test('ranges overlap when they share a point and not when they are apart', () => {
  assert.equal(rangesOverlap([1, 5], [5, 9]), true);
  assert.equal(rangesOverlap([1, 4], [5, 9]), false);
  assert.equal(rangesOverlap([5, 9], [1, 4]), false);
});

test('medianInterval takes order statistics with the binomial coverage they carry', () => {
  const { medianInterval } = require('../stats');
  // five values: only the full range reaches 90%, with coverage 1 - 2/32
  assert.deepEqual(medianInterval([5, 1, 4, 2, 3]), { low: 1, high: 5, coverage: 0.9375 });
  // ten values: the 2nd smallest to the 2nd largest covers 1 - 2 * 11/1024
  const ten = medianInterval([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(ten.low, 2);
  assert.equal(ten.high, 9);
  assert.ok(Math.abs(ten.coverage - (1 - 22 / 1024)) < 1e-12);
  assert.equal(medianInterval([3]).coverage, 0);
  assert.throws(() => medianInterval([]), /no values/);
});

test('fisherGreater matches the hypergeometric tail', () => {
  const { fisherGreater } = require('../stats');
  // 3 bad of 5 arm runs against 0 of 20 control runs: C(3,3) C(22,2) / C(25,5)
  assert.ok(Math.abs(fisherGreater(3, 5, 0, 20) - 231 / 53130) < 1e-12);
  assert.ok(Math.abs(fisherGreater(0, 5, 2, 20) - 1) < 1e-12);
  // 1 bad arm run against 1 bad control run is no evidence
  assert.ok(fisherGreater(1, 5, 1, 20) > 0.3);
});
