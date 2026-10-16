'use strict';

/**
 * Shared state of one evidence collection: the fixture, its intended-leaf listings, a scratch
 * directory per run, the native baseline run whose records become the timings file, and memoized
 * runs, so several rows can read the same execution.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listIntended } = require('../../harness');
const { copyProject, tempDir } = require('../../qualification/lib/project');
const { upstreamUrl } = require('./citations');
const drive = require('./drive');
const { FIXTURE, REPO_ROOT } = require('./upstream');

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

/**
 * `value` with every local path replaced: the scratch root by `<tmp>`, the repository by `<repo>`
 * and any other temporary folder by `<os-tmp>`, so committed evidence holds no machine-specific path.
 */
function scrubber(root) {
  const real = fs.realpathSync(root);
  const pairs = [
    [real, '<tmp>'],
    [root, '<tmp>'],
    [fs.realpathSync(REPO_ROOT), '<repo>'],
    [REPO_ROOT, '<repo>'],
    // Scratch folders of other contexts, such as the Flakiness runs of the internals rows.
    [fs.realpathSync(os.tmpdir()), '<os-tmp>'],
    [os.tmpdir(), '<os-tmp>'],
  ];
  const text = (value) => pairs.reduce((out, [from, to]) => out.split(from).join(to), value);
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk;
}

/**
 * `commit` is the upstream commit the installed version was published from; `upstreamText` reads
 * a file of the upstream repository at it (memoized).
 */
function createContext({ log = () => {}, source = FIXTURE, commit = null } = {}) {
  const root = tempDir('psb');
  const memo = new Map();
  const listings = new Map();
  const configs = new Map();
  const signatures = new Map();
  const baselines = new Map();

  const ctx = {
    cwd: source,
    root,
    log,
    scrub: scrubber(root),

    /** The text of a file of the upstream repository at the published commit. */
    upstreamText(file) {
      if (!commit) throw new Error('the context has no upstream commit');
      return ctx.once(`upstream:${file}`, async () => {
        const url = upstreamUrl(commit, file);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
        return response.text();
      });
    },

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

    /** A copy of the fixture with `edits` applied (see `copyProject`). */
    copy(name, edits) {
      return copyProject(source, ctx.dir(name), edits);
    },

    /** The config file of a project: the project's own config plus the reporter. */
    config(cwd = source, { fullyParallel = false } = {}) {
      const key = JSON.stringify([cwd, fullyParallel]);
      if (!configs.has(key)) {
        const dir = ctx.dir(`config-${configs.size + 1}`);
        configs.set(key, drive.writeConfig({ dir, project: cwd, fullyParallel }));
      }
      return configs.get(key);
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
     * Runs `shards` shards of `--shard=i/n` and returns the harness result with the partition, the
     * records, the plan lines and a summary. Options: `{ name, shards, cwd, timings, record,
     * planWorkers, granularity, plain, reporter, json, env, shard, repeatEach, workers, forward,
     * fullyParallel }`. `workers` is Playwright's `--workers` (four unless given) and
     * `planWorkers` the reporter's `workers` option. Memoized by `name`.
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
      const { timings, record, planWorkers, granularity, plain, reporter, json, env, shard } =
        options;
      const partition = drive.partitionOf({
        shards,
        dir: ctx.dir(name),
        timings,
        record,
        workers: planWorkers,
        granularity,
        plain,
        reporter,
        json,
        env,
        shard,
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
     * Runs a partition the caller built. Options: `{ name, cwd, partition, repeatEach, workers,
     * forward, fullyParallel }`. Memoized by `name`; the same name with other options throws.
     */
    runPartition(options) {
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
        return {
          ...result,
          dir,
          partition,
          listing,
          config,
          records: drive.records(partition),
          plans: drive.planLines(result.raw),
          summary: summarize(result),
        };
      });
    },

    /**
     * Native sharding with the reporter present and no timings file, one worker per shard, and the
     * timings file `update` builds from its records. `name` keys the run, `cwd` picks the project
     * and `env` is added to the environment of every shard.
     */
    baseline({ name = 'native-2', shards = 2, cwd = source, fullyParallel = false, env } = {}) {
      const asked = JSON.stringify({ shards, cwd, fullyParallel, env });
      if (baselines.has(name) && baselines.get(name) !== asked) {
        throw new Error(`baseline ${name} was asked for again with other options`);
      }
      baselines.set(name, asked);
      return ctx.once(`baseline:${name}`, () => {
        const run = ctx.run({ name, shards, cwd, workers: 1, fullyParallel, env });
        const files = run.records.filter(Boolean).map((r) => r.file);
        if (files.length !== shards)
          throw new Error(`baseline ${name} wrote ${files.length} records`);
        const timings = path.join(ctx.dir(`${name}-timings`), 'timings.json');
        const call = drive.update(timings, files);
        if (call.status !== 0) throw new Error(`update failed: ${call.stderr}`);
        return { ...run, timings, update: call };
      });
    },

    /** A copy of the baseline timings in its own folder (`update` rewrites the file it is given). */
    timingsCopy(name, from = ctx.baseline().timings) {
      const file = path.join(ctx.dir(`timings-${name}`), 'timings.json');
      fs.copyFileSync(from, file);
      return file;
    },

    /** Playwright's own split: the reporter left out. `workers` 1 by default, like the balance runs. */
    native(shards, { cwd = source, workers = 1, fullyParallel = false, name } = {}) {
      return ctx.run({
        name: name || `plain-${shards}-w${workers}${fullyParallel ? '-fp' : ''}`,
        shards,
        cwd,
        workers,
        fullyParallel,
        plain: true,
      });
    },

    /** Balanced sharding from the baseline timings, one worker per shard. */
    balanced(shards, { fullyParallel = false, name } = {}) {
      return ctx.run({
        name: name || `balanced-${shards}${fullyParallel ? '-fp' : ''}`,
        shards,
        timings: ctx.baseline().timings,
        workers: 1,
        fullyParallel,
      });
    },
  };
  return ctx;
}

module.exports = { createContext, summarize };
