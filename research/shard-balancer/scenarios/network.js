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

function guardEnv(log) {
  return { NODE_OPTIONS: `--require ${GUARD}`, PSP_NET_GUARD_LOG: log };
}

function noNetwork(ctx) {
  const dir = ctx.dir('network');
  const control = path.join(dir, 'control.log');
  spawnSync(process.execPath, ['-e', "fetch('https://example.invalid/').catch(() => {})"], {
    env: { ...process.env, ...guardEnv(control) },
  });
  const runLog = path.join(dir, 'run.log');
  const run = ctx.run({
    name: 'guarded-2',
    shards: 2,
    timings: ctx.timingsCopy('guarded'),
    env: guardEnv(runLog),
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
  const entries = [...readLog(runLog), ...readLog(cliLog)];
  const spawned = {};
  for (const entry of entries.filter((e) => e.kind === 'spawn')) {
    const name = path.basename(entry.target);
    spawned[name] = (spawned[name] || 0) + 1;
  }
  const facts = {
    controlAttempts: readLog(control).filter((e) => NETWORK_KINDS.test(e.kind)).length,
    harnessOk: run.summary.ok,
    strategies: run.records.map((r) => r && r.data.strategy),
    cliExits: calls.map((call) => call.status),
    attempts: entries.filter((e) => NETWORK_KINDS.test(e.kind)).length,
    spawned,
  };
  const programs = Object.keys(spawned).filter(
    (name) => !/^(node|.*\.js)$/.test(name) && name !== path.basename(process.execPath)
  );
  facts.programs = programs;
  return row(
    'n.no-network',
    'The reporter, `update`, `check` and `simulate` make no network connection and start no program of their own.',
    facts.controlAttempts > 0 &&
      facts.attempts === 0 &&
      facts.harnessOk &&
      programs.length === 0 &&
      facts.cliExits.every((c) => c === 0),
    facts,
    `A balanced two-shard run and the three commands under the guard: ${facts.attempts} connection attempts and no program started besides Node and Playwright's workers (${programs.length} others). The control \`fetch\` was recorded ${facts.controlAttempts} time.`
  );
}

function networkRows(ctx) {
  return [noNetwork(ctx)];
}

module.exports = { networkRows };
