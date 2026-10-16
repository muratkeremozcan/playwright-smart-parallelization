'use strict';

/**
 * Qualification harness library. `listIntended` lists the leaves a run is meant to cover,
 * `runPartition` runs a partition shard by shard, and `qualify` checks coverage, execution
 * outcomes, serial integrity and dependency accounting and returns the report.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  checkCoverage,
  checkDependencies,
  checkExecution,
  checkSerialGroups,
  checkShardRuns,
  countDependencyExecutions,
  imbalance,
} = require('./checks');
const { classify, dependencyMap, listedLeaf } = require('./leaves');
const { optionsOf, passesOption, playwrightOptionArity } = require('./cli-options');
const { TEST_LIST_FLAGS, assertSelectable, nativePartition } = require('./partitions');

const REPORTER = path.join(__dirname, 'reporter.js');
const MAX_BUFFER = 256 * 1024 * 1024;

/** The option arity of the Playwright installed for the project at `cwd`. */
function optionArityOf(cwd) {
  return playwrightOptionArity(resolveFromCwd('@playwright/test/cli', cwd));
}

function resolveFromCwd(request, cwd) {
  return require.resolve(request, { paths: [cwd] });
}

/** The resolved `@playwright/test` version of the project at `cwd`. */
function playwrightVersion(cwd) {
  return require(resolveFromCwd('@playwright/test/package.json', cwd)).version;
}

function playwright(cwd, args, env = {}) {
  const cli = resolveFromCwd('@playwright/test/cli', cwd);
  return spawnSync(process.execPath, [cli, 'test', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  });
}

/**
 * The args that select the config and the tests of a run: the `config` option, then the forwarded
 * args exactly as the user gave them. The harness never reads these, so every form Playwright
 * accepts (`-cfile`, `-c file`, `--config=file`, `-g x`, `--grep=x`, ...) reaches it unchanged.
 */
function selectionArgs({ config, forward = [] }) {
  return [...(config ? [`--config=${config}`] : []), ...forward];
}

function runArgs({ repeatEach = 1, workers = 1, selection = [] }) {
  return [`--repeat-each=${repeatEach}`, `--workers=${workers}`, ...selection];
}

/**
 * Runs `playwright test --list` with the harness reporter and returns what it wrote:
 * `{ projects, leaves }`. Playwright applies the selection and the filters, so the leaves are
 * exactly the ones a run would select.
 */
function listWithReporter(cwd, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-list-'));
  const resultFile = path.join(dir, 'list.json');
  try {
    // --forbid-only makes a focused test (.only) an error instead of a silent subset: a list shows
    // every test while a run executes the focused ones only.
    const result = playwright(cwd, ['--list', '--forbid-only', `--reporter=${REPORTER}`, ...args], {
      PSP_HARNESS_RESULT: resultFile,
    });
    if (/--forbid-only/.test(result.stderr || '')) {
      throw new Error(
        'the suite has a focused test (.only), so a run executes a subset of what it lists, ' +
          'which is not supported by the harness. Playwright says:\n' +
          result.stderr.trim().split('\n').slice(0, 3).join('\n')
      );
    }
    // The reporter fails closed with an error of its own: show that, not the stack around it.
    const reporterError = /^Error: (.+)$/m.exec(result.stderr || '');
    if (reporterError && (result.stderr || '').includes(REPORTER)) {
      throw new Error(reporterError[1]);
    }
    if (result.status !== 0 || !fs.existsSync(resultFile)) {
      throw new Error(`playwright test --list failed (exit ${result.status}): ${result.stderr}`);
    }
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Selection flags the harness cannot prove exactly-once: they make the selection depend on state
 * outside the command line, or take over what the engine under test owns (sharding), or run
 * nothing. They are rejected before any listing or run instead of qualifying a different suite.
 */
const UNSUPPORTED = [
  ['--last-failed', 'it selects tests from the state of an earlier run'],
  ['--only-changed', 'it selects tests from the state of the working tree'],
  ['--shard', 'the engine under test owns sharding, and the harness partitions the run itself'],
  ['--list', 'a list-only run executes nothing'],
];
const SEPARATOR_REASON =
  'it hands every argument after it to the tests, and the harness adds its own options after the forwarded arguments';

/**
 * Throws for a forwarded option outside the contract (see `UNSUPPORTED`), and for a separator.
 * Options are read with the option arity of the Playwright installed at `cwd`, since a value can
 * look like a flag (`--grep-invert --list` gives `--grep-invert` the pattern `--list`). The text
 * test only saves the help run for the many selections that name no such flag.
 */
function assertSupportedSelection({ cwd, forward = [] }, optionArity = optionArityOf) {
  const named = (arg) => arg === '--' || UNSUPPORTED.some(([flag]) => arg.includes(flag));
  if (!forward.some(named)) return;
  for (const { name, arg } of optionsOf(forward, optionArity(cwd))) {
    if (name === '--') throw new Error(`-- is not supported by the harness: ${SEPARATOR_REASON}`);
    const unsupported = UNSUPPORTED.find(([flag]) => flag === name);
    if (unsupported) throw new Error(`${arg} is not supported by the harness: ${unsupported[1]}`);
  }
}

function countByProject(leaves) {
  const counts = new Map();
  for (const leaf of leaves) counts.set(leaf.project, (counts.get(leaf.project) || 0) + 1);
  return counts;
}

/**
 * Lists the intended leaves and the project dependency map. The leaves come from a listing with
 * the user's selection. Two more listings with the same selection, at `--repeat-each=1` and
 * `--repeat-each=2`, tell the top-level projects apart: Playwright applies the flag to the projects
 * whose own tests the selection keeps and runs a project it only pulled in unchanged, so a project
 * is top-level when its leaf count grows between the two (see `classify`). Comparing the two keeps
 * a dependency project that repeats because its config says so a dependency. Playwright thus
 * answers `--project`, filters and `--no-deps` for the harness, with no argument read here.
 */
function listIntended({ cwd, config, repeatEach = 1, forward = [] }) {
  assertSupportedSelection({ cwd, forward });
  const selection = selectionArgs({ config, forward });
  const listed = listWithReporter(cwd, [`--repeat-each=${repeatEach}`, ...selection]);
  if (listed.shard) {
    throw new Error(
      `the config shards the run (shard ${listed.shard.current} of ${listed.shard.total}), which is ` +
        'not supported by the harness: the engine under test owns sharding'
    );
  }
  const once = countByProject(listWithReporter(cwd, [...selection, '--repeat-each=1']).leaves);
  const twice = countByProject(listWithReporter(cwd, [...selection, '--repeat-each=2']).leaves);
  const topLevel = new Set(
    [...twice.keys()].filter((project) => twice.get(project) > (once.get(project) || 0))
  );
  const leaves = classify(listed.leaves.map(listedLeaf), topLevel);
  if (!leaves.some((leaf) => !leaf.dependency)) {
    throw new Error(
      "the selection has no test to qualify: it lists no leaf, whatever Playwright's exit code says"
    );
  }
  return { leaves, dependencies: dependencyMap(listed.projects) };
}

/**
 * Runs each shard of a partition with the harness reporter and returns one result per shard. A
 * shard is `{ args, env? }`; `env` is added to the environment of that shard's run. Each result is
 * `{ index, args, exitCode, wallMs, durationMs, leaves, output }`. `leaves` is null when the shard
 * wrote no leaves file.
 */
function runPartition({ cwd, config, repeatEach = 1, workers = 1, forward = [] }, partition) {
  assertSupportedSelection({ cwd, forward });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-harness-'));
  try {
    return partition.map((shard, position) => {
      const resultFile = path.join(dir, `shard-${position + 1}.json`);
      const started = Date.now();
      const result = playwright(
        cwd,
        [
          ...runArgs({ repeatEach, workers, selection: selectionArgs({ config, forward }) }),
          `--add-reporter=${REPORTER}`,
          ...shard.args,
        ],
        { ...shard.env, PSP_HARNESS_RESULT: resultFile }
      );
      const wallMs = Date.now() - started;
      let report = null;
      if (fs.existsSync(resultFile)) {
        try {
          report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        } catch {
          report = null;
        }
      }
      return {
        index: position + 1,
        args: shard.args,
        exitCode: result.status === null ? 1 : result.status,
        wallMs,
        durationMs: report ? report.durationMs : wallMs,
        leaves: report ? report.leaves : null,
        output: `${result.stdout || ''}${result.stderr || ''}`,
      };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs every check over the executed shards and returns all violations. */
function checkAll(intended, dependencies, shards) {
  return [
    ...checkShardRuns(shards),
    ...checkCoverage(intended, shards),
    ...checkExecution(intended, shards),
    ...checkSerialGroups(intended, shards),
    ...checkDependencies(intended, shards, dependencies),
  ];
}

/**
 * Qualifies a partition against the intended leaf set. `options.partition` is the partition to
 * run; it defaults to native sharding across `options.shards`. `options.listing` reuses the result
 * of an earlier `listIntended` call. `deps` replaces `listIntended`, `runPartition`,
 * `playwrightVersion` and `optionArity` (tests inject stubs). Returns the report.
 */
function qualify(options, { log = () => {}, quiet = false, deps = {} } = {}) {
  assertSupportedSelection(options, deps.optionArity);
  const { cwd } = options;
  const list = deps.listIntended || listIntended;
  const run = deps.runPartition || runPartition;
  const versionOf = deps.playwrightVersion || playwrightVersion;
  const playwrightVersionValue = versionOf(cwd);
  log(`Playwright ${playwrightVersionValue}, Node ${process.version}`);

  const { leaves: intended, dependencies } = options.listing || list(options);
  const primary = intended.filter((leaf) => !leaf.dependency);
  log(`Intended leaves: ${primary.length} primary, ${intended.length - primary.length} dependency`);
  for (const leaf of intended) log(`  ${leaf.dependency ? '[dependency] ' : ''}${leaf.key}`);

  const partition = options.partition || nativePartition(options.shards || 2);
  // A list an engine supplies is held to the same contract as one the harness builds. Whether a
  // run gets a list follows the option arity of the installed Playwright, since a value can look
  // like a flag; the text test only saves the help run for the many runs that name no list.
  const commandLines = partition.map((shard) => [...selectionArgs(options), ...(shard.args || [])]);
  if (commandLines.some((args) => args.some((arg) => arg.includes('--test-list')))) {
    const arity = (deps.optionArity || optionArityOf)(cwd);
    if (commandLines.some((args) => passesOption(args, arity, TEST_LIST_FLAGS))) {
      assertSelectable(intended);
    }
  }
  const shards = run(options, partition);
  if (!quiet) {
    for (const shard of shards) {
      if (shard.exitCode !== 0) log(`Shard ${shard.index} output:\n${shard.output}`);
    }
  }

  const labels = new Map();
  for (const leaf of [...intended, ...shards.flatMap((shard) => shard.leaves || [])]) {
    if (leaf.label) labels.set(leaf.key, leaf.label);
  }
  const violations = checkAll(intended, dependencies, shards).map((violation) =>
    labels.has(violation.key) ? { ...violation, label: labels.get(violation.key) } : violation
  );
  const primaryKeys = new Set(primary.map((leaf) => leaf.key));
  const summaries = shards.map((shard) => ({
    index: shard.index,
    durationMs: Math.round(shard.durationMs),
    wallMs: shard.wallMs,
    leafCount: (shard.leaves || []).filter((leaf) => primaryKeys.has(leaf.key)).length,
    exitCode: shard.exitCode,
  }));
  const slowest = summaries.reduce(
    (best, shard) => (best === null || shard.durationMs > best.durationMs ? shard : best),
    null
  );

  return {
    playwright: playwrightVersionValue,
    node: process.version,
    shards: summaries,
    slowestShard: slowest ? slowest.index : null,
    imbalance: imbalance(summaries),
    dependencyExecutions: countDependencyExecutions(intended, shards),
    violations,
    ok: violations.length === 0,
  };
}

module.exports = {
  assertSupportedSelection,
  checkAll,
  listIntended,
  playwrightVersion,
  qualify,
  runPartition,
};
