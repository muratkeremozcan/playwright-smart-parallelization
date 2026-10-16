'use strict';

/**
 * Pieces of the CAP-6 network check that do not depend on the engine: the guard preload and its
 * log, the control that proves the guard catches each kind of attempt, and the OS-level network
 * block with the control that proves the block works.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUARD = path.resolve(__dirname, 'net-guard.js');

function guardEnv(logFile) {
  return { NODE_OPTIONS: `--require "${GUARD}"`, PSP_NET_GUARD_LOG: logFile };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const ATTEMPTS = ['connect', 'dns.', 'fetch'];

function attemptsIn(log) {
  return log.filter((entry) => ATTEMPTS.some((kind) => entry.kind.startsWith(kind)));
}

const PROBE = `
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const tries = [
  () => net.connect(80, 'vendor.invalid'),
  () => dns.lookup('vendor.invalid', () => {}),
  () => fetch('https://vendor.invalid/upload').catch(() => {}),
  () => http.get('http://vendor.invalid/').on('error', () => {}),
];
for (const attempt of tries) {
  try {
    attempt();
  } catch {}
}
`;

function guardControl(ctx) {
  const log = path.join(ctx.dir('network'), 'control.log');
  fs.rmSync(log, { force: true });
  const result = spawnSync(process.execPath, ['-e', PROBE], {
    encoding: 'utf8',
    env: { ...process.env, ...guardEnv(log) },
  });
  const attempts = attemptsIn(readLog(log));
  return {
    id: 'net.guard-control',
    proof: 'net',
    title: 'the guard records and refuses connect, dns, fetch and http attempts',
    status: attempts.length >= 4 && result.status === 0 ? 'pass' : 'fail',
    evidence: { exit: result.status, attempts: attempts.map((entry) => entry.kind) },
  };
}

/**
 * The OS-level network block for this platform, or null. `preserveEnv` keeps the environment of
 * the caller through `sudo`, for a command that is steered by environment variables.
 */
function osBlock({ preserveEnv = false } = {}) {
  if (process.platform === 'darwin') {
    return {
      name: 'sandbox-exec',
      wrap: ['sandbox-exec', '-p', '(version 1)(allow default)(deny network*)'],
    };
  }
  if (process.platform === 'linux') {
    return {
      name: 'unshare -n',
      wrap: ['sudo', '-n', ...(preserveEnv ? ['-E'] : []), 'unshare', '-n'],
    };
  }
  return null;
}

const CONNECT = `
const net = require('node:net');
net.connect(Number(process.argv[1]), '127.0.0.1')
  .on('connect', () => process.exit(0))
  .on('error', (error) => { console.log(error.code); process.exit(2); });
`;

/** Whether the block stops a loopback connection that succeeds without it. */
async function blockWorks(block) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const run = (wrap) => {
    const [command, ...rest] = [...wrap, process.execPath, '-e', CONNECT, String(port)];
    return spawnSync(command, rest, { encoding: 'utf8' });
  };
  const open = run([]);
  const blocked = run(block.wrap);
  server.close();
  // The blocked child must have run Node and been refused, which prints the error code.
  if (blocked.error) {
    server.close();
    return { open: open.status === 0, blocked: false, code: '' };
  }
  const code = blocked.stdout.trim();
  return { open: open.status === 0, blocked: blocked.status !== 0 && /^[A-Z]+$/.test(code), code };
}

module.exports = {
  GUARD,
  PROBE,
  attemptsIn,
  blockWorks,
  guardControl,
  guardEnv,
  osBlock,
  readLog,
};
