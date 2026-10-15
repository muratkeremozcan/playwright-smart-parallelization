'use strict';

/**
 * Negative control. Runs a clean partition of the intended leaf set through `--test-list`, then
 * three deliberately broken ones, each end to end. The harness must accept the clean one and reject
 * every broken one with its expected violation kind, otherwise a passing qualification proves
 * nothing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { groupBase, testId } = require('./leaves');
const { listIntended, playwrightVersion, qualify } = require('./index');
const { testListPartition } = require('./partitions');

const SHARD_COUNT = 2;
const CLEAN = 'none';

/**
 * Atomic units of a clean assignment: a serial group is one unit, every other test is its own
 * unit. A unit holds the keys of all its repeats, because `--test-list` selects a test in all of
 * its repeats.
 */
function buildUnits(leaves) {
  const units = new Map();
  for (const leaf of leaves) {
    if (leaf.dependency) continue;
    const id = leaf.serialGroup ? groupBase(leaf.serialGroup) : testId(leaf);
    const unit = units.get(id) || { id, serial: Boolean(leaf.serialGroup), leaves: [] };
    unit.leaves.push(leaf);
    units.set(id, unit);
  }
  return [...units.values()];
}

/** A clean two-shard assignment: largest units first, each to the least loaded shard. */
function cleanAssignment(units) {
  const shards = Array.from({ length: SHARD_COUNT }, () => ({ keys: [], load: 0 }));
  for (const unit of [...units].sort((a, b) => b.leaves.length - a.leaves.length)) {
    const target = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    target.keys.push(...unit.leaves.map((leaf) => leaf.key));
    target.load += unit.leaves.length;
  }
  return shards.map((shard) => shard.keys);
}

function keysOfTest(leaves, id) {
  return leaves.filter((leaf) => testId(leaf) === id).map((leaf) => leaf.key);
}

/** Returns `[{ name, expected, assignment }]`: the clean assignment, then three broken ones. */
function buildControls(leaves) {
  const units = buildUnits(leaves);
  const plain = units.find((unit) => !unit.serial);
  const group = units.find((unit) => unit.serial && new Set(unit.leaves.map(testId)).size > 1);
  if (!plain || !group) {
    throw new Error('the negative control needs a plain test and a multi-test serial group');
  }
  const clean = cleanAssignment(units);
  const plainKeys = new Set(plain.leaves.map((leaf) => leaf.key));
  const homeOf = (keys) => clean.findIndex((shard) => keys.some((key) => shard.includes(key)));

  const dropped = clean.map((shard) => shard.filter((key) => !plainKeys.has(key)));

  const duplicated = clean.map((shard) => [...shard]);
  duplicated[(homeOf([...plainKeys]) + 1) % SHARD_COUNT].push(...plainKeys);

  const lastTest = [...new Set(group.leaves.map(testId))].at(-1);
  const moved = new Set(keysOfTest(leaves, lastTest));
  const home = homeOf([...moved]);
  const split = clean.map((shard) => shard.filter((key) => !moved.has(key)));
  split[(home + 1) % SHARD_COUNT].push(...moved);

  return [
    { name: 'clean partition', expected: CLEAN, assignment: clean },
    { name: 'dropped leaf', expected: 'missing', assignment: dropped },
    { name: 'duplicated leaf', expected: 'duplicate', assignment: duplicated },
    { name: 'split serial group', expected: 'serial-split', assignment: split },
  ];
}

/**
 * Runs the controls. A broken control passes when it is rejected with its expected violation kind.
 * The clean control passes when it is accepted with no violation, which proves the `--test-list`
 * path works at all. `ok` is true only when every control passes. `deps` replaces `listIntended`,
 * `qualify` and `playwrightVersion` (tests inject stubs).
 */
function runNegativeControl(options, { log = () => {}, deps = {} } = {}) {
  const list = deps.listIntended || listIntended;
  const run = deps.qualify || qualify;
  const versionOf = deps.playwrightVersion || playwrightVersion;
  const playwrightVersionValue = versionOf(options.cwd);
  log(`Playwright ${playwrightVersionValue}, Node ${process.version}`);

  const listing = list(options);
  const controls = buildControls(listing.leaves);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-negative-'));
  try {
    const results = controls.map((control, index) => {
      const controlDir = path.join(dir, String(index));
      fs.mkdirSync(controlDir);
      const partition = testListPartition(control.assignment, listing.leaves, controlDir);
      const report = run({ ...options, partition, listing }, { quiet: true });
      const kinds = [...new Set(report.violations.map((violation) => violation.kind))];
      const passed =
        control.expected === CLEAN
          ? report.ok && kinds.length === 0
          : !report.ok && kinds.includes(control.expected);
      log(
        `${passed ? 'passed' : 'FAILED'}: ${control.name}, expected ${control.expected}, ` +
          `found ${kinds.join(', ') || 'no violations'}`
      );
      return { name: control.name, expected: control.expected, kinds, passed };
    });
    return {
      playwright: playwrightVersionValue,
      node: process.version,
      ok: results.every((result) => result.passed),
      controls: results,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { buildControls, buildUnits, cleanAssignment, runNegativeControl };
