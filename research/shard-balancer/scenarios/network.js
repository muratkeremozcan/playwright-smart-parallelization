'use strict';

/**
 * Row `n.no-network`: the reporter, `update`, `check` and `simulate` under the network guard of the
 * qualifications (`qualification/lib/net-guard.js`), which records and refuses every socket, DNS
 * lookup and `fetch` in a process and its Node children. A control shows the guard records a
 * `fetch` it refuses, so an empty log means no attempt.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const drive = require('../drive');
const { row } = require('./row');

const GUARD = path.resolve(__dirname, '..', '..', '..', 'qualification', 'lib', 'net-guard.js');
const NETWORK_KINDS = /^(connect|dns\.|fetch)/;

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The programs a guard log records as started, by name, Node and its scripts left out. */
function programsOf(entries) {
  const counts = {};
  for (const entry of entries.filter((e) => e.kind === 'spawn')) {
    const name = path.basename(entry.target);
    if (/^(node|.*\.js)$/.test(name) || name === path.basename(process.execPath)) continue;
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

const programList = (counts) => {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? 'no program'
    : entries.map(([name, n]) => `${name} ${n}`).join(', ');
};

function guardEnv(log) {
  return { NODE_OPTIONS: `--require ${GUARD}`, PSP_NET_GUARD_LOG: log };
}

function noNetwork(ctx) {
  const dir = ctx.dir('network');
  const control = path.join(dir, 'control.log');
  const controlCall = spawnSync(
    process.execPath,
    ['-e', "fetch('https://example.invalid/').catch(() => {})"],
    { env: { ...process.env, ...guardEnv(control) }, encoding: 'utf8' }
  );
  const runLog = path.join(dir, 'run.log');
  const run = ctx.run({
    name: 'guarded-2',
    shards: 2,
    timings: ctx.timingsCopy('guarded'),
    env: guardEnv(runLog),
  });
  // The same shards without the reporter: the programs Playwright itself starts (git for its
  // metadata on CI, its workers), which the reporter must not add to.
  const plainLog = path.join(dir, 'plain.log');
  const plain = ctx.run({
    name: 'guarded-plain-2',
    shards: 2,
    plain: true,
    env: guardEnv(plainLog),
  });
  const cliLog = path.join(dir, 'cli.log');
  const timings = ctx.timingsCopy('guarded-cli');
  const files = run.records.filter(Boolean).map((r) => r.file);
  const calls = [
    drive.update(timings, files, { env: guardEnv(cliLog) }),
    drive.check(files, { env: guardEnv(cliLog) }),
    drive.simulate(
      {
        timings,
        list: drive.listReport({
          cwd: ctx.cwd,
          config: ctx.config(),
          file: path.join(dir, 'list.json'),
        }),
        shards: 2,
      },
      { env: guardEnv(cliLog) }
    ),
  ];
  const network = (entries) => entries.filter((e) => NETWORK_KINDS.test(e.kind)).length;
  const runSpawned = programsOf(readLog(runLog));
  const plainSpawned = programsOf(readLog(plainLog));
  // Workers are Node processes whose count follows the split, so only other programs are compared.
  const added = Object.keys(runSpawned).filter(
    (name) => runSpawned[name] > (plainSpawned[name] || 0)
  );
  const facts = {
    controlAttempts: network(readLog(control)),
    controlExit: controlCall.status,
    controlStderr: (controlCall.stderr || '').trim().split('\n')[0] || '',
    harnessOk: run.summary.ok && plain.summary.ok,
    strategies: run.records.map((r) => r && r.data.strategy),
    cliExits: calls.map((call) => call.status),
    attempts: network([...readLog(runLog), ...readLog(cliLog)]),
    reporterRunPrograms: runSpawned,
    plainRunPrograms: plainSpawned,
    programsAdded: added,
    cliSpawns: readLog(cliLog).filter((e) => e.kind === 'spawn').length,
  };
  return row(
    'n.no-network',
    'The reporter, `update`, `check` and `simulate` make no network connection; the reporter starts no program beyond what Playwright starts without it, and the commands start none.',
    facts.controlAttempts > 0 &&
      facts.attempts === 0 &&
      facts.harnessOk &&
      added.length === 0 &&
      facts.cliSpawns === 0 &&
      facts.cliExits.every((c) => c === 0),
    facts,
    `A balanced two-shard run and the three commands under the guard: ${facts.attempts} connection attempts. Besides Node workers the reporter run started ${programList(runSpawned)} and the same shards without the reporter ${programList(plainSpawned)}, so the reporter added ${added.length} programs; the commands started ${facts.cliSpawns}. The control \`fetch\` was recorded ${facts.controlAttempts} time.`
  );
}

function networkRows(ctx) {
  return [noNetwork(ctx)];
}

module.exports = { networkRows };
