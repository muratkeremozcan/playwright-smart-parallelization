'use strict';

/**
 * Negative control. Runs a clean partition of the intended leaf set through `--test-list`, then
 * deliberately broken ones, each end to end: a dropped leaf, a duplicated leaf, a split serial
 * group and a run where every test skips at runtime. Selection scenarios add a clean and a broken
 * run each for a dependency project selected by name, selected and filtered down to its own test,
 * filtered with no project named, and selected with `--no-deps`. The harness must accept the clean
 * ones and reject every broken one with its expected violation kind, otherwise a passing
 * qualification proves nothing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dependencyProjects, groupBase } = require('./leaves');
const { assertSupportedSelection, listIntended, playwrightVersion, qualify } = require('./index');
const { assertSelectable, nativePartition, testListPartition } = require('./partitions');

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
    const id = leaf.serialGroup ? groupBase(leaf.serialGroup) : leaf.testRef;
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
  return leaves.filter((leaf) => leaf.testRef === id).map((leaf) => leaf.key);
}

/**
 * Returns `[{ name, expected, assignment, env?, flagged? }]`: the clean assignment, then four broken
 * ones. `env` is set in the environment of every shard of that control. A control with `flagged`
 * passes only when every one of those leaf keys carries the expected violation.
 */
function buildControls(leaves) {
  const units = buildUnits(leaves);
  const plain = units.find((unit) => !unit.serial);
  const group = units.find(
    (unit) => unit.serial && new Set(unit.leaves.map((leaf) => leaf.testRef)).size > 1
  );
  if (!plain || !group) {
    throw new Error('the negative control needs a plain test and a multi-test serial group');
  }
  const clean = cleanAssignment(units);
  const plainKeys = new Set(plain.leaves.map((leaf) => leaf.key));
  const homeOf = (keys) => clean.findIndex((shard) => keys.some((key) => shard.includes(key)));

  const dropped = clean.map((shard) => shard.filter((key) => !plainKeys.has(key)));

  const duplicated = clean.map((shard) => [...shard]);
  duplicated[(homeOf([...plainKeys]) + 1) % SHARD_COUNT].push(...plainKeys);

  const lastTest = [...new Set(group.leaves.map((leaf) => leaf.testRef))].at(-1);
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
 * Selection scenarios for a dependency project P (a setup project with a teardown project T) that
 * a dependent project D (a browser project) needs. Each scenario is `{ forward, controls }`:
 * `forward` is the selection to list the intended leaves with, and `controls(listing)` returns
 * `[{ name, expected, forward, partition, flagged }]`, a clean run and a broken one. In every
 * scenario P's own leaves are primary, so a broken run that never executes them must be rejected.
 *
 * - P selected by name: a run of T alone leaves P unrun (`missing`).
 * - P and D selected, then filtered down to P's test: D has no test left, so P is still primary.
 * - The same filter with no project named at all, where every project is selected.
 * - P and T selected with `--no-deps`: both are top-level, so P in every shard is `duplicate`.
 * - `--grep-invert --no-deps`: Playwright reads `--no-deps` as the grep-invert pattern, so the
 *   dependencies stay in the listing, and a run that separates the dependent projects from them is
 *   `dependency-missing`.
 *
 * `leaves` is the unfiltered intended set, used to find P's test title. The scenarios build their
 * own selection, so forwarded arguments do not reach them; the `config` option does.
 */
function buildSelectionScenarios(dependencies, leaves) {
  const { project, implicit } = pickDependencySelection(dependencies);
  const needed = dependencyProjects(dependencies);
  const dependent = Object.keys(dependencies).find(
    (name) => !needed.has(name) && dependencies[name].includes(project)
  );
  const own = leaves.find((leaf) => leaf.project === project);
  if (!dependent || !own) {
    throw new Error(
      `the negative control needs a project that depends on ${project} and a ${project} test`
    );
  }
  const grep = own.titlePath.at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keysOf = (listing) =>
    listing.leaves
      .filter((leaf) => leaf.project === project && !leaf.dependency)
      .map((leaf) => leaf.key);
  const only = (name) => [{ args: [`--project=${name}`] }];
  // A filter that leaves only P's own test: the dependent project has nothing left, so P stays
  // under test whether or not a `--project` names it.
  const filteredScenario = (forward, label) => ({
    forward,
    controls: (listing) => {
      if (listing.leaves.some((leaf) => leaf.project === dependent)) {
        throw new Error(`the ${project} filter of the negative control also selects ${dependent}`);
      }
      return [
        {
          name: `${label}, clean`,
          expected: CLEAN,
          forward,
          partition: nativePartition(SHARD_COUNT),
        },
        {
          name: `${label}, only ${implicit} runs`,
          expected: 'missing',
          forward: [],
          partition: only(implicit),
          flagged: keysOf(listing),
        },
      ];
    },
  });

  const selected = [`--project=${project}`];
  const filtered = ['--project', project, dependent, '--grep', grep];
  const unnamed = ['--grep', grep];
  const flat = ['--no-deps'];
  const topLevel = [...flat, `--project=${project}`, `--project=${implicit}`];
  // The grep keeps the run short: only the browser projects' "loads the page" tests remain.
  const consumed = ['--grep-invert', '--no-deps', '--grep', 'loads the page'];
  const dependents = Object.keys(dependencies).filter(
    (name) => !needed.has(name) && dependencies[name].includes(project)
  );
  return [
    {
      forward: selected,
      controls: (listing) => [
        {
          name: `selected ${project} project, clean`,
          expected: CLEAN,
          forward: selected,
          partition: nativePartition(SHARD_COUNT),
        },
        {
          name: `selected ${project} project, only ${implicit} runs`,
          expected: 'missing',
          forward: [],
          partition: only(implicit),
          flagged: keysOf(listing),
        },
      ],
    },
    filteredScenario(filtered, `${project} and ${dependent} selected, filtered to ${project}`),
    filteredScenario(unnamed, `no project named, filtered to ${project}`),
    {
      forward: topLevel,
      controls: (listing) => [
        {
          name: `${project} and ${implicit} without dependencies, clean`,
          expected: CLEAN,
          forward: topLevel,
          partition: nativePartition(SHARD_COUNT),
        },
        {
          name: `${project} and ${implicit} without dependencies, ${project} in every shard`,
          expected: 'duplicate',
          forward: flat,
          partition: [...only(project), ...only(project)],
          flagged: keysOf(listing),
        },
      ],
    },
    {
      forward: consumed,
      controls: (listing) => {
        const dependencyKeys = listing.leaves.filter((leaf) => leaf.dependency).map((l) => l.key);
        return [
          {
            name: '--grep-invert --no-deps, dependencies stay, clean',
            expected: CLEAN,
            forward: consumed,
            partition: nativePartition(SHARD_COUNT),
          },
          {
            name: `--grep-invert --no-deps, ${dependents.join(' and ')} run apart from ${project}`,
            expected: 'dependency-missing',
            forward: consumed,
            partition: dependents.map((name) => ({ args: [`--project=${name}`, '--no-deps'] })),
            flagged: dependencyKeys,
          },
        ];
      },
    },
  ];
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
  assertSupportedSelection(options.forward);
  const list = deps.listIntended || listIntended;
  const run = deps.qualify || qualify;
  const versionOf = deps.playwrightVersion || playwrightVersion;
  const playwrightVersionValue = versionOf(options.cwd);
  log(`Playwright ${playwrightVersionValue}, Node ${process.version}`);

  const listing = list(options);
  assertSelectable(listing.leaves);
  const listingControls = buildControls(listing.leaves);
  const forward = options.forward || [];
  // The scenarios are built from the unfiltered suite: filters or `--no-deps` in the forwarded
  // args could hide the dependency map or the setup test they rely on.
  const full = forward.length === 0 ? listing : list({ ...options, forward: [] });
  const scenarios = buildSelectionScenarios(full.dependencies, full.leaves).flatMap((scenario) => {
    const scenarioListing = list({ ...options, forward: scenario.forward });
    return scenario.controls(scenarioListing).map((control) => ({
      ...control,
      listing: scenarioListing,
    }));
  });
  const controls = [
    ...listingControls.map((control) => ({ ...control, forward, listing })),
    ...scenarios,
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
  buildSelectionScenarios,
  buildUnits,
  cleanAssignment,
  runNegativeControl,
};
