'use strict';

/**
 * CAP-6: the plan and timing steps make no outbound connection. Three checks:
 *
 *   guard-control  the preload in `qualification/lib/net-guard.js` records and refuses every kind of attempt, so an
 *                  empty log means something.
 *   plan-timing    `assign`, `extract-timing` and `merge-timing` run under the guard and attempt
 *                  nothing.
 *   os-block       the same steps run under an OS-level network block (macOS `sandbox-exec`,
 *                  Linux `unshare -n`) and answer as they do without it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  attemptsIn,
  blockWorks,
  guardControl,
  guardEnv,
  osBlock,
  readLog,
} = require('../../lib/netcheck');
const { assign, extractTiming, mergeTiming } = require('../engine');
const { chromiumList } = require('./assignment');

/** The plan and timing steps over the baseline reports; `options` is the engine call options. */
function planAndTiming(ctx, options, label) {
  const baseline = ctx.baseline();
  const dir = ctx.dir(`network-${label}`);
  const report = baseline.partition[0].env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const testList = chromiumList(ctx).file;
  const timing = baseline.history.timing.chromium;
  const cold = assign({ testList, shards: 3 }, options);
  const warm = assign({ testList, shards: 3, timingFile: timing }, options);
  const artifact = path.join(dir, 'artifact.json');
  const extract = extractTiming(
    { reportFile: report, outputFile: artifact, project: 'chromium' },
    options
  );
  const output = path.join(dir, 'merged.json');
  const merge = mergeTiming({ existing: timing, artifacts: [artifact], output }, options);
  const digest = crypto.createHash('sha256').update(JSON.stringify(warm.assignment)).digest('hex');
  return {
    exits: [cold.status, warm.status, extract.status, merge.status],
    steps: ['assign cold', 'assign history', 'extract-timing', 'merge-timing'],
    assignmentDigest: digest,
  };
}

/**
 * Runs the plan and timing steps under the guard and judges them: every step exits 0, nothing
 * attempts a connection and nothing spawns another process, because a spawned program is outside
 * the reach of the guard. `root` runs a different copy of the engine package.
 */
function judgePlanTiming(ctx, { label, root }) {
  const log = path.join(ctx.dir(`network-${label}`), 'steps.log');
  fs.rmSync(log, { force: true });
  const run = planAndTiming(ctx, { env: guardEnv(log), root }, label);
  const entries = readLog(log);
  const attempts = attemptsIn(entries);
  const spawns = entries.filter((entry) => entry.kind === 'spawn').map((entry) => entry.target);
  return {
    status:
      run.exits.every((code) => code === 0) && attempts.length === 0 && spawns.length === 0
        ? 'pass'
        : 'fail',
    evidence: { steps: run.steps, exits: run.exits, attempts: attempts.length, spawns },
  };
}

function planTiming(ctx) {
  const { status, evidence } = judgePlanTiming(ctx, { label: 'guard' });
  return {
    id: 'net.plan-timing',
    proof: 'net',
    title: 'assign, extract-timing and merge-timing under the guard',
    status,
    evidence,
  };
}

/**
 * A copy of the installed engine whose `assign` also calls `curl`. The copy is the negative
 * control of the network check: it must be rejected, or an empty log would prove nothing about
 * programs the engine starts.
 */
function mutatedEngine(ctx) {
  const dir = ctx.dir('network-mutated');
  const modules = path.join(dir, 'node_modules');
  fs.cpSync(path.resolve(__dirname, '..', 'node_modules'), modules, { recursive: true });
  const root = path.join(modules, '@nsxbet', 'playwright-orchestrator');
  const file = path.join(root, 'dist', 'commands', 'assign.js');
  const source = fs.readFileSync(file, 'utf8');
  const hook = 'const { flags } = await this.parse(Assign);';
  if (!source.includes(hook)) throw new Error('assign.js has changed: update the mutation');
  const call = '__curl("curl", ["-s", "http://vendor.invalid/upload"], { stdio: "ignore" });';
  fs.writeFileSync(
    file,
    `import { execFileSync as __curl } from "node:child_process";\n${source.replace(
      hook,
      `${hook}\n        try { ${call} } catch {}`
    )}`
  );
  return root;
}

function mutationControl(ctx) {
  const root = mutatedEngine(ctx);
  const { status, evidence } = judgePlanTiming(ctx, { label: 'mutated', root });
  return {
    id: 'net.mutation-control',
    proof: 'net',
    title: 'an engine that shells out to curl is rejected by the same check',
    status: status === 'fail' && evidence.spawns.includes('curl') ? 'pass' : 'fail',
    evidence: { mutatedStatus: status, spawns: evidence.spawns, exits: evidence.exits },
  };
}

async function osBlockRow(ctx, { required }) {
  const block = osBlock();
  const unavailable = (reason) => {
    if (required) throw new Error(`OS-level network block required but ${reason}`);
    return {
      id: 'net.os-block',
      proof: 'net',
      title: 'assign, extract-timing and merge-timing under an OS-level network block',
      status: 'skipped',
      evidence: { reason },
    };
  };
  if (!block) return unavailable(`unsupported platform ${process.platform}`);
  const control = await blockWorks(block);
  if (!control.open || !control.blocked)
    return unavailable(`${block.name} did not block a loopback connection`);
  const blockedRun = planAndTiming(ctx, { wrap: block.wrap }, 'os');
  const openRun = planAndTiming(ctx, {}, 'open');
  return {
    id: 'net.os-block',
    proof: 'net',
    title: 'assign, extract-timing and merge-timing under an OS-level network block',
    status:
      blockedRun.exits.every((code) => code === 0) &&
      blockedRun.assignmentDigest === openRun.assignmentDigest
        ? 'pass'
        : 'fail',
    evidence: {
      method: block.name,
      controlBlockedCode: control.code,
      steps: blockedRun.steps,
      exits: blockedRun.exits,
      sameAssignmentAsOpen: blockedRun.assignmentDigest === openRun.assignmentDigest,
    },
  };
}

async function networkRows(ctx, { requireOsBlock = false } = {}) {
  return [
    guardControl(ctx),
    planTiming(ctx),
    mutationControl(ctx),
    await osBlockRow(ctx, { required: requireOsBlock }),
  ];
}

module.exports = { networkRows };
