'use strict';

/**
 * Network guard, loaded with `node --require`. Every attempt to open a socket, resolve a name or
 * call `fetch` is appended to the file named by `PSP_NET_GUARD_LOG` as one JSON line and then
 * refused with an error, so a guarded process cannot reach any host. Child processes started
 * through `NODE_OPTIONS` inherit the guard, and every process spawn is logged as well.
 */

const childProcess = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');

const LOG = process.env.PSP_NET_GUARD_LOG;

function record(kind, target) {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ kind, target, pid: process.pid })}\n`);
}

function refuse(kind, target) {
  record(kind, target);
  throw new Error(`network guard refused ${kind} ${target}`);
}

function describeConnect(args) {
  // net.connect passes Socket#connect one array of already normalized arguments.
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (first && typeof first === 'object') {
    return first.path || `${first.host || 'localhost'}:${first.port}`;
  }
  if (/^\d+$/.test(String(first))) return `${second || 'localhost'}:${first}`;
  return String(first);
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  return refuse('connect', describeConnect(args));
};

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  dns[name] = (host) => refuse(`dns.${name}`, String(host));
  if (dns.promises)
    dns.promises[name] = async (host) => refuse(`dns.promises.${name}`, String(host));
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = async (input) =>
    refuse('fetch', String(input && input.url ? input.url : input));
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function guardedSpawn(command, ...rest) {
    record('spawn', String(command));
    return original.call(this, command, ...rest);
  };
}
