'use strict';

/**
 * Partitions. A partition is an array of shards and a shard is `{ args, env? }`: the Playwright CLI
 * arguments that select that shard's tests and, optionally, extra environment for its run. Any
 * engine can supply its own shards.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listLine, loadLine, loadSentinel } = require('./leaves');

/** Native Playwright sharding: `--shard=i/n` for i in 1..n. */
function nativePartition(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard count must be a positive integer, got ${count}`);
  }
  return Array.from({ length: count }, (_, index) => ({
    args: [`--shard=${index + 1}/${count}`],
  }));
}

/** The options that hand Playwright a file of tests to select. */
const TEST_LIST_FLAGS = ['--test-list', '--test-list-invert'];

const isControl = (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;

// The separator of a list line, control characters and newlines would corrupt a line.
function unsafeReason(value) {
  // A lone surrogate becomes a replacement character in a UTF-8 list file and the line then
  // selects nothing.
  if (!value.isWellFormed()) {
    return 'is not well-formed UTF-16 (an unpaired surrogate), which a UTF-8 list file corrupts';
  }
  if ([...value].some((char) => char === '›' || isControl(char))) {
    return 'contains "›", a control character or a newline';
  }
  if (value !== value.trim()) return 'has leading or trailing whitespace';
  return null;
}

/**
 * Playwright's `--test-list` is a lossy selector: a line is split on "›", trimmed, matched to a
 * test by project name, the file of the test call and a title-path prefix, and the line and column
 * are ignored. A suite that the selector cannot pick out exactly is rejected before any run, with
 * the leaves named:
 * - a project name, file, spec file, suite title or test title with "›", a control character, a newline or
 *   surrounding whitespace, which the line cannot carry;
 * - two different tests with one project, call file and title path (a helper registers them for
 *   several specs), which no line tells apart;
 * - a test whose title path is a prefix of another's, so its line selects both.
 * Dependency leaves are not selected by a line and are skipped.
 */
function assertSelectable(leaves) {
  const primary = leaves.filter((leaf) => !leaf.dependency);
  for (const leaf of primary) {
    const fields = [
      ['project', leaf.project],
      ['file', leaf.file],
      ['spec file', leaf.specFile],
    ];
    leaf.titlePath.forEach((title, depth) => fields.push([`title ${depth + 1}`, title]));
    for (const [field, value] of fields) {
      const reason = unsafeReason(value);
      if (reason) {
        throw new Error(
          `${leaf.label} cannot be selected exactly by --test-list: its ${field} ` +
            `${JSON.stringify(value)} ${reason}`
        );
      }
    }
  }
  const groups = new Map();
  for (const leaf of primary) {
    const group = `${leaf.project}\u0001${leaf.file}`;
    groups.set(group, [...(groups.get(group) || []), leaf]);
  }
  for (const sameFile of groups.values()) {
    for (const [i, a] of sameFile.entries()) {
      for (const b of sameFile.slice(i + 1)) {
        if (a.testRef === b.testRef) continue;
        const [shorter, longer] = a.titlePath.length <= b.titlePath.length ? [a, b] : [b, a];
        if (!shorter.titlePath.every((title, depth) => title === longer.titlePath[depth])) continue;
        const how =
          shorter.titlePath.length === longer.titlePath.length
            ? 'the same project, call file and title path, so no line tells them apart'
            : 'a title path that is a prefix of the other, so one line selects both';
        throw new Error(
          `${shorter.label} and ${longer.label} cannot be selected exactly by --test-list: ${how}`
        );
      }
    }
  }
}

/**
 * Explicit assignment through `--test-list`. `assignment` is an array of leaf key arrays, one per
 * shard. `leaves` is the intended set the keys come from. One list file per shard is written into
 * `dir`. `--test-list` selects a test in all of its repeats and adds dependency projects itself,
 * so each test appears once per shard however many of its repeats or dependencies are assigned.
 *
 * A test matches by the file of its call, which is a helper's file when a helper registers it, and
 * Playwright loads only the files a list line names. A helper is not a test file, so every leaf
 * also gets a load line for its spec file with a title no test has: it loads the spec and selects
 * nothing by itself. Which specs a shard loads then decides which of the helper's tests it runs.
 */
function testListPartition(assignment, leaves, dir) {
  assertSelectable(leaves);
  const sentinel = loadSentinel(leaves);
  const byKey = new Map(leaves.map((leaf) => [leaf.key, leaf]));
  return assignment.map((keys, index) => {
    const lines = new Set();
    for (const key of keys) {
      const leaf = byKey.get(key);
      if (!leaf) throw new Error(`unknown leaf key in assignment: ${key}`);
      if (!leaf.dependency) {
        lines.add(listLine(leaf));
        if (leaf.specFile !== leaf.file) lines.add(loadLine(leaf, sentinel));
      }
    }
    const file = path.join(dir, `shard-${index + 1}.txt`);
    fs.writeFileSync(file, `${[...lines].join('\n')}\n`);
    return { args: ['--test-list', file] };
  });
}

module.exports = { TEST_LIST_FLAGS, assertSelectable, nativePartition, testListPartition };
