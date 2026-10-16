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
