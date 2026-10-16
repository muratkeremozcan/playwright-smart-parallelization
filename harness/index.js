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
const { nativePartition } = require('./partitions');

const REPORTER = path.join(__dirname, 'reporter.js');
const MAX_BUFFER = 256 * 1024 * 1024;

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
    const result = playwright(cwd, ['--list', `--reporter=${REPORTER}`, ...args], {
      PSP_HARNESS_RESULT: resultFile,
    });
    if (result.status !== 0 || !fs.existsSync(resultFile)) {
      throw new Error(`playwright test --list failed (exit ${result.status}): ${result.stderr}`);
    }
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Lists the intended leaves and the project dependency map. The leaves come from a listing with
 * the user's selection. A second listing with the same selection and `--repeat-each=2` tells the
 * top-level projects apart: Playwright repeats the projects whose own tests the selection keeps and
 * runs the ones it only pulled in once, so the projects with a repeated leaf are top-level (see
 * `classify`). Playwright thus answers `--project`, filters and `--no-deps` for the harness, with no
 * argument read here.
 */
function listIntended({ cwd, config, repeatEach = 1, forward = [] }) {
  const selection = selectionArgs({ config, forward });
  const listed = listWithReporter(cwd, [`--repeat-each=${repeatEach}`, ...selection]);
  const probe = listWithReporter(cwd, [...selection, '--repeat-each=2']);
  const topLevel = new Set(
    probe.leaves.filter((leaf) => leaf.repeatIndex > 0).map((leaf) => leaf.project)
  );
  return {
    leaves: classify(listed.leaves.map(listedLeaf), topLevel),
    dependencies: dependencyMap(listed.projects),
  };
}

/**
 * Runs each shard of a partition with the harness reporter and returns one result per shard. A
 * shard is `{ args, env? }`; `env` is added to the environment of that shard's run. Each result is
 * `{ index, args, exitCode, wallMs, durationMs, leaves, output }`. `leaves` is null when the shard
 * wrote no leaves file.
 */
function runPartition({ cwd, config, repeatEach = 1, workers = 1, forward = [] }, partition) {
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
 * of an earlier `listIntended` call. `deps` replaces `listIntended`, `runPartition` and
 * `playwrightVersion` (tests inject stubs). Returns the report.
 */
function qualify(options, { log = () => {}, quiet = false, deps = {} } = {}) {
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
  const shards = run(options, partition);
  if (!quiet) {
    for (const shard of shards) {
      if (shard.exitCode !== 0) log(`Shard ${shard.index} output:\n${shard.output}`);
    }
  }

  const violations = checkAll(intended, dependencies, shards);
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
  checkAll,
  listIntended,
  playwrightVersion,
  qualify,
  runPartition,
};
