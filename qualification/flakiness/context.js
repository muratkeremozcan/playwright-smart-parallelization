'use strict';

/**
 * Shared state of one evidence collection: the fixture, its intended-leaf listing, a scratch
 * directory per run and the native baseline run that supplies timing history. Runs are memoized
 * by name so several proof rows can read the same execution.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listIntended } = require('../../harness');
const { copyProject, writeJson } = require('../lib/project');
const drive = require('./drive');

// Fixture tests sleep for multiples of 10 ms, so 50 ms keeps history faithful and reproducible.
const HISTORY_ROUND_MS = 50;

const FIXTURE = path.resolve(__dirname, '..', '..', 'fixtures', 'consumer');

function summarize(result) {
  const { report, kinds } = result;
  const durations = report.shards.map((shard) => shard.durationMs);
  return {
    shards: report.shards,
    slowestMs: Math.max(...durations),
    imbalance: report.imbalance,
    kinds,
    groups: report.violations.filter((v) => v.kind === 'serial-split').map((v) => v.group),
    ok: report.ok,
  };
}

function createContext({ log = () => {}, source = FIXTURE } = {}) {
  const root = drive.tempDir('run');
  const memo = new Map();
  const listings = new Map();
  const configs = new Map();
  const signatures = new Map();
  const baselines = new Map();

  const ctx = {
    cwd: source,
    root,
    log,

    /** Removes the scratch directory of the collection. */
    dispose() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        log(`could not remove ${root}: ${error.message}`);
      }
    },

    /** Memoizes `build` under `key`. */
    once(key, build) {
      if (!memo.has(key)) memo.set(key, build());
      return memo.get(key);
    },

    /** A fresh scratch directory for one named step. */
    dir(name) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },

    /** A copy of the fixture with `edits` applied. The reporter reads the commit, so it is a git repository. */
    copy(name, edits) {
      return copyProject(source, ctx.dir(name), edits, { git: true });
    },

    /** The config file of a project: the project's own config plus the Flakiness reporter. */
    config(cwd = source, { fullyParallel = false } = {}) {
      const key = JSON.stringify([cwd, fullyParallel]);
      if (!configs.has(key)) {
        const dir = ctx.dir(`config-${configs.size + 1}`);
        configs.set(key, drive.writeConfig({ dir, project: cwd, fullyParallel }));
      }
      return configs.get(key);
    },

    /** A valid timings file that knows no test: the file of a run with no history. */
    coldTimings() {
      return ctx.once('cold-timings', () =>
        writeJson(path.join(ctx.dir('cold'), 'timings.json'), { environments: [] })
      );
    },

    /** The intended-leaf listing for a selection (memoized). */
    listing({ cwd = source, repeatEach = 1, forward = [], fullyParallel = false } = {}) {
      const key = JSON.stringify([cwd, repeatEach, forward, fullyParallel]);
      if (!listings.has(key)) {
        const config = ctx.config(cwd, { fullyParallel });
        listings.set(key, listIntended({ cwd, config, repeatEach, forward }));
      }
      return listings.get(key);
    },

    /**
     * Runs `shards` shards of `--shard=i/n` and returns the harness result with the partition and
     * a summary. Options: `{ name, shards, cwd, timings, plain, upload, json, blob, output,
     * repeatEach, workers, forward, fullyParallel, env }`. Memoized by `name`. `timings` set runs
     * balanced sharding; unset runs Playwright's native split. Runs use four workers unless
     * `workers` says otherwise; balance runs set 1.
     */
    run(options) {
      const {
        name,
        shards = 2,
        cwd = source,
        fullyParallel,
        repeatEach,
        workers,
        forward,
      } = options;
      const { timings, plain, upload, json, blob, output, env } = options;
      const partition = drive.partitionOf({
        shards,
        dir: ctx.dir(name),
        timings,
        plain,
        upload,
        json,
        blob,
        output,
        env,
      });
      return ctx.runPartition({
        name,
        cwd,
        partition,
        fullyParallel,
        repeatEach,
        workers,
        forward,
      });
    },

    /**
     * Runs a partition the caller built, for checks that give shards different environments or
     * arguments. Options: `{ name, cwd, partition, repeatEach, workers, forward, fullyParallel }`.
     * Returns the harness result with the partition, listing and a summary. Memoized by `name`.
     */
    runPartition(options) {
      // A name stands for one execution: the same name with other options is a bug in the caller.
      const signature = JSON.stringify({ ...options, name: undefined });
      if (signatures.has(options.name) && signatures.get(options.name) !== signature) {
        throw new Error(`run ${options.name} was asked for again with other options`);
      }
      signatures.set(options.name, signature);
      return ctx.once(`run:${options.name}`, () => {
        log(`run ${options.name}`);
        const {
          name,
          cwd = source,
          partition,
          repeatEach = 1,
          workers = 4,
          forward = [],
          fullyParallel = false,
        } = options;
        const dir = ctx.dir(name);
        const listing = ctx.listing({ cwd, repeatEach, forward, fullyParallel });
        const config = ctx.config(cwd, { fullyParallel });
        const result = drive.execute({
          cwd,
          config,
          partition,
          listing,
          repeatEach,
          workers,
          forward,
        });
        return { ...result, dir, partition, listing, config, summary: summarize(result) };
      });
    },

    /**
     * Native sharding with the Flakiness reporter present (it writes the reports the history is
     * built from) and the timings file built from those reports. `name` keys the run, `cwd`
     * picks the project (the fixture by default) and `roundMs` rounds the durations, none for 0.
     */
    baseline({
      name = 'native2',
      shards = 2,
      cwd = source,
      fullyParallel = false,
      roundMs = HISTORY_ROUND_MS,
    } = {}) {
      const asked = JSON.stringify({ shards, cwd, fullyParallel, roundMs });
      if (baselines.has(name) && baselines.get(name) !== asked) {
        throw new Error(`baseline ${name} was asked for again with other options`);
      }
      baselines.set(name, asked);
      return ctx.once(`baseline:${name}`, () => {
        const run = ctx.run({ name, shards, cwd, workers: 1, fullyParallel, json: true });
        const history = drive.buildHistory({
          dir: run.dir,
          reports: drive.flakinessReports(run.partition),
          roundMs,
        });
        return { ...run, history };
      });
    },

    /**
     * Balanced sharding planned from the native baseline's timings, one worker per shard, the
     * runs balance, serial-group and history checks read.
     */
    balancedRun(shards, { fullyParallel = false, name } = {}) {
      const baseline = ctx.baseline({
        fullyParallel,
        name: fullyParallel ? 'native2-fp' : 'native2',
      });
      return ctx.run({
        name: name || `balanced-${fullyParallel ? 'fp-' : ''}${shards}`,
        shards,
        timings: baseline.history.file,
        workers: 1,
        fullyParallel,
        json: true,
      });
    },
  };
  return ctx;
}

module.exports = { FIXTURE, HISTORY_ROUND_MS, createContext, summarize };
