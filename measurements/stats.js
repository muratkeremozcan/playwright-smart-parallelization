'use strict';

/** Plain descriptive statistics over a list of numbers. */

function median(values) {
  if (values.length === 0) throw new Error('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median, extremes and the range as a share of the median. */
function summarize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mid = median(values);
  return { n: values.length, median: mid, min, max, spread: mid === 0 ? 0 : (max - min) / mid };
}

/** True when two value lists share any point of their min to max ranges. */
function rangesOverlap(a, b) {
  return Math.min(...a) <= Math.max(...b) && Math.min(...b) <= Math.max(...a);
}

module.exports = { median, rangesOverlap, summarize };
