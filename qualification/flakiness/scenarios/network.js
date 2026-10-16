'use strict';

/**
 * CAP-6: the reporter and the timings command make no outbound connection. Checks:
 *
 *   guard-control     the preload in `qualification/lib/net-guard.js` records and refuses every
 *                     kind of attempt, so an empty log means something.
 *   balanced-run      a balanced two-shard run, credentials and a vendor endpoint in the
 *                     environment, makes no attempt and starts only the programs the package's
 *                     source starts.
 *   timings-build     `build` makes no attempt and starts nothing.
 *   upload-control    the same step with `disableUpload` left off is caught: the flag is what
 *                     keeps the reporter offline, and the guard sees the attempt.
 *   mutation-control  a copy of the reporter that also runs `curl` is rejected by the same check.
 *   os-block          the same steps under an OS-level network block (macOS `sandbox-exec`, Linux
 *                     `unshare -n`) give the same plan and the same timings file as without it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  attemptsIn,
  blockWorks,
  guardControl,
  guardEnv,
  osBlock,
  readLog,
} = require('../../lib/netcheck');
const { buildTimings, packageRoot, reporterPath } = require('../engine');
const { flakinessReports } = require('../drive');
const { listShard, runShard } = require('../playwright');

// What the package's source starts: `git` for the commit, `uname` and `sw_vers` for the system
// description, `vm_stat` for the memory samples on macOS. Playwright forks its own workers.
const PROBES = new Set(['git', 'uname', 'sw_vers', 'vm_stat']);
const WORKER = /[\\/]playwright[\\/]lib[\\/]worker[\\/]workerProcessEntry\.js$/;

// A credential and an endpoint in the environment: if the reporter ever tried to upload, it would
// reach for this host, which the guard refuses and records.
const VENDOR = {
  FLAKINESS_ACCESS_TOKEN: 'not-a-real-token',
  FLAKINESS_ENDPOINT: 'https://vendor.invalid',
};

/** The program a logged spawn started: the first word of the command, without its directory. */
function program(target) {
  return path.basename(target.split(/\s+/)[0]);
}

/** Spawned programs counted by name, Playwright workers apart. */
function spawnsOf(entries) {
  const counts = {};
  let workers = 0;
  for (const entry of entries.filter((candidate) => candidate.kind === 'spawn')) {
    if (WORKER.test(entry.target)) workers += 1;
    else counts[program(entry.target)] = (counts[program(entry.target)] || 0) + 1;
  }
  return { programs: counts, workers };
}

/** Programs outside the set the package's source starts. */
function unexpectedPrograms(spawns) {
  return Object.keys(spawns.programs).filter((name) => !PROBES.has(name));
}

/**
 * Judges a guarded step: every step exited 0, nothing attempted a connection and nothing outside
 * the known set was started, because a started program is outside the reach of the guard.
 */
function judge(entries, exits) {
  const attempts = attemptsIn(entries);
  const spawns = spawnsOf(entries);
  const unexpected = unexpectedPrograms(spawns);
  return {
    status:
      exits.every((code) => code === 0) && attempts.length === 0 && unexpected.length === 0
        ? 'pass'
        : 'fail',
    evidence: {
      exits,
      attempts: attempts.length,
      attemptTargets: [...new Set(attempts.map((entry) => entry.target))],
      spawnedPrograms: spawns.programs,
      playwrightWorkers: spawns.workers,
      unexpectedPrograms: unexpected,
    },
  };
}

/**
 * A two-shard balanced run under the guard. `reporter` runs a different copy of the package and
 * `upload` leaves `disableUpload` off. The environment carries a credential and an endpoint.
 */
function guardedRun(ctx, { label, reporter, upload }) {
  return ctx.once(`network:${label}`, () => {
    const dir = ctx.dir(`network-${label}`);
    const log = path.join(dir, 'guard.log');
    fs.rmSync(log, { force: true });
    const run = ctx.run({
      name: `network-${label}`,
      shards: 2,
      timings: ctx.baseline().history.file,
      workers: 2,
      upload,
      env: { ...guardEnv(log), ...VENDOR, ...(reporter ? { PSP_FLK_REPORTER: reporter } : {}) },
    });
    return { run, entries: readLog(log) };
  });
}

function balancedRun(ctx) {
  const { run, entries } = guardedRun(ctx, { label: 'guard' });
  const { status, evidence } = judge(
    entries,
    run.raw.map((shard) => shard.exitCode)
  );
  return {
    id: 'net.balanced-run',
    proof: 'net',
    title:
      'a balanced run with disableUpload, a credential and a vendor endpoint in the environment',
    status,
    evidence: { ...evidence, credentialsInEnvironment: true },
  };
}

function timingsBuild(ctx) {
  const dir = ctx.dir('network-build');
  const log = path.join(dir, 'guard.log');
  fs.rmSync(log, { force: true });
  const reports = flakinessReports(ctx.baseline().partition);
  const call = buildTimings(
    { inputs: reports, output: path.join(dir, 'timings.json') },
    { env: { ...guardEnv(log), ...VENDOR } }
  );
  const entries = readLog(log);
  const { status, evidence } = judge(entries, [call.status]);
  return {
    id: 'net.timings-build',
    proof: 'net',
    title: 'flakiness-playwright-timings build under the guard',
    status:
      status === 'pass' && Object.keys(evidence.spawnedPrograms).length === 0 ? 'pass' : 'fail',
    evidence,
  };
}

/** One listing of shard 1 under the guard; `reporter` and `upload` as in `guardedRun`. */
function guardedListing(ctx, { label, reporter, upload }) {
  const dir = ctx.dir(`network-${label}`);
  const log = path.join(dir, 'guard.log');
  fs.rmSync(log, { force: true });
  const result = listShard({
    cwd: ctx.cwd,
    config: ctx.config(),
    shard: '1/2',
    env: {
      ...guardEnv(log),
      ...VENDOR,
      PSP_FLK_TIMINGS: ctx.baseline().history.file,
      FLAKINESS_OUTPUT_DIR: path.join(dir, 'report'),
      ...(upload ? { PSP_FLK_UPLOAD: '1' } : {}),
      ...(reporter ? { PSP_FLK_REPORTER: reporter } : {}),
    },
  });
  return { result, entries: readLog(log) };
}

function uploadControl(ctx) {
  const { result, entries } = guardedListing(ctx, { label: 'upload', upload: true });
  const attempts = attemptsIn(entries);
  return {
    id: 'net.upload-control',
    proof: 'net',
    title: 'with disableUpload left off, the reporter reaches for the vendor and the guard sees it',
    status:
      attempts.length > 0 &&
      attempts.every((entry) => entry.target.startsWith(VENDOR.FLAKINESS_ENDPOINT))
        ? 'pass'
        : 'fail',
    evidence: {
      exit: result.exitCode,
      attempts: attempts.length,
      attemptTargets: [...new Set(attempts.map((entry) => entry.target))],
    },
  };
}

/**
 * A copy of the installed package whose reporter also calls `curl` before it plans. The copy is
 * the negative control of the network check: it must be rejected, or an empty log would prove
 * nothing about programs the reporter starts.
 */
function mutatedReporter(ctx) {
  const target = path.join(ctx.dir('network-mutated'), 'package');
  fs.cpSync(packageRoot(), target, { recursive: true });
  const file = reporterPath(target);
  const source = fs.readFileSync(file, 'utf8');
  const hook = 'this._preprocessCalled = true;';
  if (!source.includes(hook)) throw new Error('the reporter has changed: update the mutation');
  const call =
    'try { (await import("node:child_process")).execFileSync("curl", ' +
    '["-s", "http://vendor.invalid/upload"], { stdio: "ignore" }); } catch {}';
  fs.writeFileSync(file, source.replace(hook, `${hook}\n    ${call}`));
  return file;
}

function mutationControl(ctx) {
  const reporter = mutatedReporter(ctx);
  const { result, entries } = guardedListing(ctx, { label: 'mutated', reporter });
  const { status, evidence } = judge(entries, [result.exitCode]);
  return {
    id: 'net.mutation-control',
    proof: 'net',
    title: 'a reporter that shells out to curl is rejected by the same check',
    status: status === 'fail' && evidence.unexpectedPrograms.includes('curl') ? 'pass' : 'fail',
    evidence: {
      mutatedStatus: status,
      unexpectedPrograms: evidence.unexpectedPrograms,
      spawnedPrograms: evidence.spawnedPrograms,
    },
  };
}

/**
 * On Linux the blocked run goes through `sudo` and writes as root, into the output directory of
 * the config as well. The files go back to the user, so later runs can write there and the
 * scratch directory can be removed.
 */
function giveBack(dir) {
  if (process.platform !== 'linux') return;
  const owner = `${process.getuid()}:${process.getgid()}`;
  spawnSync('sudo', ['-n', 'chown', '-R', owner, dir], { stdio: 'ignore' });
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The leaves each shard runs, as one string, for comparing a blocked run with an open one. */
function placementOf(shards) {
  return JSON.stringify(shards.map((shard) => (shard.leaves || []).map((leaf) => leaf.key).sort()));
}

async function osBlockRow(ctx, { required }) {
  const block = osBlock({ preserveEnv: true });
  const unavailable = (reason) => {
    if (required) throw new Error(`OS-level network block required but ${reason}`);
    return {
      id: 'net.os-block',
      proof: 'net',
      title: 'a balanced run and build under an OS-level network block',
      status: 'skipped',
      evidence: { reason },
    };
  };
  if (!block) return unavailable(`unsupported platform ${process.platform}`);
  const control = await blockWorks(block);
  if (!control.open || !control.blocked) {
    return unavailable(`${block.name} did not block a loopback connection`);
  }
  const dir = ctx.dir('network-os');
  const timings = ctx.baseline().history.file;
  const shardsRun = (wrap, label) =>
    [1, 2].map((index) =>
      runShard({
        cwd: ctx.cwd,
        config: ctx.config(),
        shard: `${index}/2`,
        wrap,
        args: ['--workers=2'],
        env: {
          PSP_FLK_TIMINGS: timings,
          FLAKINESS_OUTPUT_DIR: path.join(dir, `${label}-${index}`),
        },
      })
    );
  const blocked = shardsRun(block.wrap, 'blocked');
  giveBack(ctx.root);
  const open = shardsRun([], 'open');
  const reports = flakinessReports(ctx.baseline().partition);
  const build = (wrap, label) =>
    buildTimings({ inputs: reports, output: path.join(dir, `${label}.json`) }, { wrap });
  const blockedBuild = build(block.wrap, 'build-blocked');
  const openBuild = build([], 'build-open');
  const samePlan = placementOf(blocked) === placementOf(open);
  const sameTimings =
    blockedBuild.status === 0 &&
    openBuild.status === 0 &&
    digest(path.join(dir, 'build-blocked.json')) === digest(path.join(dir, 'build-open.json'));
  return {
    id: 'net.os-block',
    proof: 'net',
    title: 'a balanced run and build under an OS-level network block',
    status:
      blocked.every((shard) => shard.exitCode === 0) && samePlan && sameTimings ? 'pass' : 'fail',
    evidence: {
      method: block.name,
      controlBlockedCode: control.code,
      exits: blocked.map((shard) => shard.exitCode),
      buildExit: blockedBuild.status,
      samePlanAsOpen: samePlan,
      sameTimingsAsOpen: sameTimings,
    },
  };
}

async function networkRows(ctx, { requireOsBlock = false } = {}) {
  return [
    guardControl(ctx),
    balancedRun(ctx),
    timingsBuild(ctx),
    uploadControl(ctx),
    mutationControl(ctx),
    await osBlockRow(ctx, { required: requireOsBlock }),
  ];
}

module.exports = { PROBES, guardedRun, judge, networkRows, program, spawnsOf, unexpectedPrograms };
