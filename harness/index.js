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
const {
  applyDependencies,
  deriveDependencies,
  parseList,
  projectNames,
  selectedProjects,
} = require('./leaves');
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
 * The config selection (`-c` or `--config`) in forwarded args. Dependencies are declared at config
 * level, so the per-project probes carry this and nothing else of the user's selection.
 */
function configArgs(args) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-c' || arg === '--config') {
      kept.push(arg, args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--config=') || arg.startsWith('-c=')) {
      kept.push(arg);
    }
  }
  return kept;
}

function runArgs({ repeatEach = 1, workers = 1, forward = [] }) {
  return [`--repeat-each=${repeatEach}`, `--workers=${workers}`, ...forward];
}

function listJson(cwd, args) {
  const result = playwright(cwd, ['--list', '--reporter=json', ...args]);
  if (result.status !== 0) {
    throw new Error(`playwright test --list failed (exit ${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Lists the intended leaves and the project dependency map. The listing honors the forwarded
 * selection args and repeat count. Dependencies come from one `--project=P` listing per project,
 * which carries the repeat count and config selection only. A dependency project the forwarded
 * `--project` selects by name has primary leaves unless another selected project needs it.
 */
function listIntended({ cwd, repeatEach = 1, forward = [] }) {
  const base = [`--repeat-each=${repeatEach}`];
  const json = listJson(cwd, [...base, ...forward]);
  const listsByProject = {};
  for (const project of projectNames(json)) {
    const probe = listJson(cwd, [...base, ...configArgs(forward), `--project=${project}`]);
    listsByProject[project] = parseList(probe);
  }
  const dependencies = deriveDependencies(listsByProject);
  const selected = selectedProjects(forward, projectNames(json));
  return { leaves: applyDependencies(parseList(json), dependencies, selected), dependencies };
}

/**
 * Runs each shard of a partition with the harness reporter and returns one result per shard. A
 * shard is `{ args, env? }`; `env` is added to the environment of that shard's run. Each result is
 * `{ index, args, exitCode, wallMs, durationMs, leaves, output }`. `leaves` is null when the shard
 * wrote no leaves file.
 */
function runPartition({ cwd, repeatEach = 1, workers = 1, forward = [] }, partition) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-harness-'));
  try {
    return partition.map((shard, position) => {
      const resultFile = path.join(dir, `shard-${position + 1}.json`);
      const started = Date.now();
      const result = playwright(
        cwd,
        [...runArgs({ repeatEach, workers, forward }), `--add-reporter=${REPORTER}`, ...shard.args],
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
  configArgs,
  listIntended,
  playwrightVersion,
  qualify,
  runPartition,
};
