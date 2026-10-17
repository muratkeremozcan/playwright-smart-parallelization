'use strict';

/**
 * Prices tests from a history. A known test costs the median of its samples. An unknown test costs
 * the median of the known tests in its describe, else its file, else its project, else the whole
 * history. A test skipped before it runs costs nothing.
 *
 * A test key is the JSON array `[project, spec file, ...describe titles, test title]`, so the
 * describe, file and project scopes come from its parts with no separator to misread.
 *
 * The hierarchy and the median are ported from playwright-shard-balancer@0.1.2 (`src/estimate.ts`
 * and `src/timings.ts:89-93` at commit 4c8f847c94324064e06e30815c1cb1a9369c63f8,
 * https://github.com/qa-gary-parker/playwright-shard-balancer). That code is under this notice:
 *
 * MIT License
 *
 * Copyright (c) 2026 Gary Parker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The key of a test: `[project, file, ...titles]` as JSON. */
const testKey = (project, file, titles) => JSON.stringify([project, file, ...titles]);

const scopeKey = (parts) => JSON.stringify(parts);

/**
 * `tests` is the `tests` object of a history: key to `{ samples: [[runId, ms], ...] }`. Returns
 * `{ knownCount, isKnown(key), estimate({ key, staticSkip }), price(key) }`.
 */
function createEstimator(tests = {}) {
  const known = new Map();
  const byParent = new Map();
  const byFile = new Map();
  const byProject = new Map();
  const all = [];
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const key of Object.keys(tests).sort()) {
    const value = median(tests[key].samples.map((sample) => sample[1]));
    known.set(key, value);
    all.push(value);
    const parts = JSON.parse(key);
    const fileScope = scopeKey(parts.slice(0, 2));
    // A describe exists when the key has titles beyond the test's own.
    if (parts.length > 3) push(byParent, scopeKey(parts.slice(0, -1)), value);
    push(byFile, fileScope, value);
    push(byProject, parts[0], value);
  }
  const cache = new Map();
  const groupMedian = (id, values) => {
    if (!values || !values.length) return undefined;
    if (!cache.has(id)) cache.set(id, median(values));
    return cache.get(id);
  };
  const globalMedian = all.length ? median(all) : 1;
  const first = (...values) => values.find((value) => value !== undefined);
  return {
    knownCount: known.size,
    isKnown: (key) => known.has(key),
    estimate: ({ key, staticSkip = false }) => {
      if (staticSkip) return 0;
      if (known.has(key)) return known.get(key);
      const parts = JSON.parse(key);
      const parent = parts.length > 3 ? scopeKey(parts.slice(0, -1)) : null;
      const fileScope = scopeKey(parts.slice(0, 2));
      return first(
        parent ? groupMedian(`d:${parent}`, byParent.get(parent)) : undefined,
        groupMedian(`f:${fileScope}`, byFile.get(fileScope)),
        groupMedian(`p:${parts[0]}`, byProject.get(parts[0])),
        globalMedian
      );
    },
  };
}

module.exports = { createEstimator, median, testKey };
