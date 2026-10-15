'use strict';

/**
 * Negative control. Runs a clean partition of the intended leaf set through `--test-list`, then
 * deliberately broken ones, each end to end: a dropped leaf, a duplicated leaf, a split serial
 * group and a run where every test skips at runtime. A second pair covers a dependency project
 * selected by name, one clean and one that runs only its teardown. The harness must accept the
 * clean ones and reject every broken one with its expected violation kind, otherwise a passing
 * qualification proves nothing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dependencyProjects, groupBase, testId } = require('./leaves');
const { configArgs, listIntended, playwrightVersion, qualify } = require('./index');
const { nativePartition, testListPartition } = require('./partitions');

const SHARD_COUNT = 2;
const CLEAN = 'none';
// The consumer fixture skips every test at runtime when this variable is set.
const SKIP_ALL = { PSP_FIXTURE_SKIP_ALL: '1' };

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

/**
 * Returns `[{ name, expected, assignment, env?, flagged? }]`: the clean assignment, then four broken
 * ones. `env` is set in the environment of every shard of that control. A control with `flagged`
 * passes only when every one of those leaf keys carries the expected violation.
 */
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
    {
      name: 'skipped at runtime',
      expected: 'not-executed',
      assignment: clean,
      env: SKIP_ALL,
      // Every test skips, so the check must flag every primary leaf, not just one of them.
      flagged: leaves.filter((leaf) => !leaf.dependency).map((leaf) => leaf.key),
    },
  ];
}

/**
 * The dependency project to select by name: one that another project depends on and that has a
 * dependency of its own, such as a setup project with a teardown project.
 */
function pickDependencySelection(dependencies) {
  const needed = dependencyProjects(dependencies);
  const project = Object.keys(dependencies).find(
    (name) => needed.has(name) && dependencies[name].length > 0
  );
  if (!project) {
    throw new Error(
      'the negative control needs a dependency project that has a dependency of its own'
    );
  }
  return { project, implicit: dependencies[project][0] };
}

/**
 * Controls for a dependency project selected by name (`--project=P`). Its own leaves are primary,
 * so a run that executes only the project it pulls in (its teardown) must be rejected as missing
 * them. `forward` is the selection to list the intended leaves with. Each control carries the
 * `forward` and `partition` of its run, `[{ name, expected, forward, partition }]`.
 */
function buildDependencyControls(dependencies, base) {
  const { project, implicit } = pickDependencySelection(dependencies);
  const forward = [...base, `--project=${project}`];
  return {
    forward,
    controls: [
      {
        name: `selected ${project} project, clean`,
        expected: CLEAN,
        forward,
        partition: nativePartition(SHARD_COUNT),
      },
      {
        name: `selected ${project} project, only ${implicit} runs`,
        expected: 'missing',
        forward: base,
        partition: [{ args: [`--project=${implicit}`] }],
      },
    ],
  };
}

/** Adds `env` to every shard of a partition. */
function withEnv(partition, env) {
  return env ? partition.map((shard) => ({ ...shard, env })) : partition;
}

/**
 * Runs the controls. A broken control passes when it is rejected with its expected violation kind.
 * A clean control passes when it is accepted with no violation, which proves the `--test-list` and
 * the `--project` paths work at all. `ok` is true only when every control passes. `deps` replaces
 * `listIntended`, `qualify` and `playwrightVersion` (tests inject stubs).
 */
function runNegativeControl(options, { log = () => {}, deps = {} } = {}) {
  const list = deps.listIntended || listIntended;
  const run = deps.qualify || qualify;
  const versionOf = deps.playwrightVersion || playwrightVersion;
  const playwrightVersionValue = versionOf(options.cwd);
  log(`Playwright ${playwrightVersionValue}, Node ${process.version}`);

  const listing = list(options);
  const forward = options.forward || [];
  const dependencySelection = buildDependencyControls(listing.dependencies, configArgs(forward));
  const dependencyListing = list({ ...options, forward: dependencySelection.forward });
  const controls = [
    ...buildControls(listing.leaves).map((control) => ({ ...control, forward, listing })),
    ...dependencySelection.controls.map((control) => ({ ...control, listing: dependencyListing })),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-negative-'));
  try {
    const results = controls.map((control, index) => {
      const controlDir = path.join(dir, String(index));
      fs.mkdirSync(controlDir);
      const partition =
        control.partition ||
        withEnv(
          testListPartition(control.assignment, control.listing.leaves, controlDir),
          control.env
        );
      const report = run(
        { ...options, forward: control.forward, partition, listing: control.listing },
        { quiet: true }
      );
      const kinds = [...new Set(report.violations.map((violation) => violation.kind))];
      const flagged = new Set(
        report.violations
          .filter((violation) => violation.kind === control.expected)
          .map((violation) => violation.key)
      );
      const passed =
        control.expected === CLEAN
          ? report.ok && kinds.length === 0
          : !report.ok &&
            kinds.includes(control.expected) &&
            (control.flagged || []).every((key) => flagged.has(key));
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

module.exports = {
  buildControls,
  buildDependencyControls,
  buildUnits,
  cleanAssignment,
  runNegativeControl,
};
