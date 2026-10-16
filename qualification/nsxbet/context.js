'use strict';

/**
 * Shared state of one evidence collection: the fixture, its intended-leaf listing, a scratch
 * directory per run and the native baseline run that supplies timing history. Runs are memoized
 * by name so several proof rows can read the same execution.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listIntended } = require('../../harness');
const { nativePartition } = require('../../harness/partitions');
const { copyProject } = require('../lib/project');
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

    /** A copy of the fixture with `edits` applied, in a scratch directory named `name`. */
    copy(name, edits) {
      return copyProject(source, ctx.dir(name), edits);
    },

    /** The intended-leaf listing for a selection (memoized). */
    listing({ cwd = source, repeatEach = 1, forward = [] } = {}) {
      const key = JSON.stringify([cwd, repeatEach, forward]);
      if (!listings.has(key)) listings.set(key, listIntended({ cwd, repeatEach, forward }));
      return listings.get(key);
    },

    /**
     * Runs native sharding with Playwright JSON reports and builds the timing history from them.
     * `name` keys the run, `cwd` picks the project (the fixture by default).
     */
    baseline({ name = 'native2', shards = 2, cwd = source } = {}) {
      return ctx.once(`baseline:${name}`, () => {
        log(`run ${name}`);
        const dir = ctx.dir(name);
        const listing = ctx.listing({ cwd });
        const partition = drive.withReports(nativePartition(shards), dir);
        const result = drive.execute({ cwd, partition, listing });
        const history = drive.buildHistory({
          dir,
          reports: drive.reportFiles(partition),
          listing,
          roundMs: HISTORY_ROUND_MS,
        });
        return { ...result, dir, partition, history, summary: summarize(result) };
      });
    },

    /**
     * Plans with the engine and runs the result through the harness. `options`: `{ name, flow,
     * shards, timing, assign, forward, repeatEach, workers, cwd, reports }`. Memoized by `name`.
     * Runs use four workers unless `workers` says otherwise; balance runs set 1.
     */
    engineRun(options) {
      return ctx.once(`run:${options.name}`, () => {
        log(`run ${options.name}`);
        const { cwd = source, forward = [], repeatEach = 1, shards = 2, workers = 4 } = options;
        const dir = ctx.dir(options.name);
        const listing = ctx.listing({ cwd, repeatEach, forward });
        const planned = drive.plan({ ...options, cwd, dir, listing, forward, repeatEach, shards });
        const partition = options.reports
          ? drive.withReports(planned.partition, dir, options.reports)
          : planned.partition;
        const result = drive.execute({ cwd, partition, listing, repeatEach, workers, forward });
        return { ...result, dir, planned, partition, listing, summary: summarize(result) };
      });
    },

    /**
     * The engine run planned from the native baseline's history, one worker per shard, with
     * JSON reports. Balance, serial-group and history checks all read this one execution.
     */
    engineHistoryRun(shards, flow = 'merged') {
      return ctx.engineRun({
        name: `${flow}-history-${shards}`,
        flow,
        shards,
        timing: ctx.baseline().history.timing,
        workers: 1,
        reports: {},
      });
    },
  };
  return ctx;
}

module.exports = { FIXTURE, HISTORY_ROUND_MS, createContext, summarize };
