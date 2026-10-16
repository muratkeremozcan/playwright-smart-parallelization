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

/** n choose k as a float; exact for the small counts of a measurement campaign. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i += 1) result = (result * (n - i + 1)) / i;
  return result;
}

/**
 * A distribution-free interval for the median of `values`: the k-th smallest to the k-th largest
 * value, with the largest k whose coverage, 1 - 2 P(Binomial(n, 1/2) < k), stays at or above
 * `level`. With fewer values than that needs it widens to the full range, and its coverage says so.
 */
function medianInterval(values, level = 0.9) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) throw new Error('interval of no values');
  const coverage = (k) => {
    let tail = 0;
    for (let i = 0; i < k; i += 1) tail += choose(n, i) / 2 ** n;
    return 1 - 2 * tail;
  };
  let k = 1;
  while (k + 1 <= Math.floor((n + 1) / 2) && coverage(k + 1) >= level) k += 1;
  return { low: sorted[k - 1], high: sorted[n - k], coverage: coverage(k) };
}

/**
 * One-sided Fisher exact test: the chance that a group of `n` drawn from all `n + m` items holds
 * `a` or more of the `a + c` marked ones, when the marks fall without regard to the group.
 */
function fisherGreater(a, n, c, m) {
  const marked = a + c;
  const total = n + m;
  let p = 0;
  for (let x = a; x <= Math.min(n, marked); x += 1) {
    p += (choose(marked, x) * choose(total - marked, n - x)) / choose(total, n);
  }
  return Math.min(1, p);
}

module.exports = { choose, fisherGreater, median, medianInterval, rangesOverlap, summarize };
