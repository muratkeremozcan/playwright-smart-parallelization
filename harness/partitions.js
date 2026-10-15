'use strict';

/**
 * Partitions. A partition is an array of shards and a shard is `{ args }`, the Playwright CLI
 * arguments that select that shard's tests. Any engine can supply its own `{ args }` shards.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listLine } = require('./leaves');

/** Native Playwright sharding: `--shard=i/n` for i in 1..n. */
function nativePartition(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard count must be a positive integer, got ${count}`);
  }
  return Array.from({ length: count }, (_, index) => ({
    args: [`--shard=${index + 1}/${count}`],
  }));
}

/**
 * Explicit assignment through `--test-list`. `assignment` is an array of leaf key arrays, one per
 * shard. `leaves` is the intended set the keys come from. One list file per shard is written into
 * `dir`. `--test-list` selects a test in all of its repeats and adds dependency projects itself,
 * so each test appears once per shard however many of its repeats or dependencies are assigned.
 */
function testListPartition(assignment, leaves, dir) {
  const byKey = new Map(leaves.map((leaf) => [leaf.key, leaf]));
  return assignment.map((keys, index) => {
    const lines = new Set();
    for (const key of keys) {
      const leaf = byKey.get(key);
      if (!leaf) throw new Error(`unknown leaf key in assignment: ${key}`);
      if (!leaf.dependency) lines.add(listLine(leaf));
    }
    const file = path.join(dir, `shard-${index + 1}.txt`);
    fs.writeFileSync(file, `${[...lines].join('\n')}\n`);
    return { args: ['--test-list', file] };
  });
}

module.exports = { nativePartition, testListPartition };
