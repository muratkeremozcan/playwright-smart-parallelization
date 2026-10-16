'use strict';

/**
 * The Playwright version of a project, read before anything is installed: from the lockfile of
 * npm, pnpm, yarn (classic and berry) or bun, or from an installed `node_modules`, searching up
 * from the working directory to `stop` (the workspace). `@playwright/test` is preferred, then
 * `playwright`. In a workspace the lockfile entry is the one Node would resolve from the working
 * directory: the nearest nested npm `node_modules` entry, or the pnpm importer of that directory.
 * Returns `{ version, source }` or `{ version: null, source: null }`.
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGES = ['@playwright/test', 'playwright'];
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

const valid = (version) => (typeof version === 'string' && VERSION.test(version) ? version : null);

/** The folders Node searches from `rel` (POSIX, relative to the lockfile) up to the root. */
function upward(rel) {
  const parts = rel && rel !== '.' ? rel.split('/') : [];
  const out = [];
  for (let n = parts.length; n >= 0; n--) out.push(parts.slice(0, n).join('/'));
  return out;
}

function fromPackageLock(text, rel = '') {
  const lock = JSON.parse(text);
  for (const name of PACKAGES) {
    for (const folder of upward(rel)) {
      const entry = (lock.packages || {})[`${folder ? `${folder}/` : ''}node_modules/${name}`];
      if (entry && valid(entry.version)) return entry.version;
    }
    const legacy = (lock.dependencies || {})[name];
    if (legacy && valid(legacy.version)) return legacy.version;
  }
  return null;
}

const escape = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The version a pnpm importer (`rel`, `.` for the root) depends on, or null. */
function fromPnpmImporter(text, rel) {
  const lines = text.split('\n');
  const start = lines.indexOf('importers:');
  if (start === -1) return null;
  const header = new RegExp(`^  ['"]?${escape(rel || '.')}['"]?:\\s*$`);
  let i = start + 1;
  while (i < lines.length && !header.test(lines[i])) {
    if (/^\S/.test(lines[i])) return null;
    i++;
  }
  const block = [];
  for (i++; i < lines.length && (lines[i] === '' || /^ {3,}/.test(lines[i])); i++)
    block.push(lines[i]);
  for (const name of PACKAGES) {
    let section = '';
    for (let k = 0; k < block.length; k++) {
      const head = /^ {4}([\w-]+):\s*$/.exec(block[k]);
      if (head) section = head[1];
      // pnpm 5 lists the ranges under `specifiers` and the resolved versions under the dependencies.
      if (section === 'specifiers') continue;
      const match = new RegExp(`^\\s+['"]?${escape(name)}['"]?:\\s*(\\S*)\\s*$`).exec(block[k]);
      if (!match) continue;
      if (match[1]) return valid(match[1].replace(/\(.*$/, ''));
      const nested =
        /^\s+version:\s*['"]?([^'"\s(]+)/.exec(block[k + 1] || '') ||
        /^\s+version:\s*['"]?([^'"\s(]+)/.exec(block[k + 2] || '');
      if (nested) return valid(nested[1]);
    }
  }
  return null;
}

function fromPnpmLock(text, rel = '') {
  if (/^importers:/m.test(text)) {
    for (const folder of upward(rel)) {
      const version = fromPnpmImporter(text, folder);
      if (version) return version;
    }
  }
  for (const name of PACKAGES) {
    // packages: '/@playwright/test@1.64.1:' (v6) or '@playwright/test@1.64.1:' (v9)
    const match = new RegExp(
      `^\\s+['"]?/?${escape(name)}@(\\d+\\.\\d+\\.\\d+[^'":(\\s]*)`,
      'm'
    ).exec(text);
    if (match && valid(match[1])) return match[1];
  }
  return null;
}

function fromYarnLock(text) {
  const blocks = text.split(/\n(?=\S)/);
  for (const name of PACKAGES) {
    const head = new RegExp(`^"?${escape(name)}@`);
    for (const block of blocks) {
      const [first] = block.split('\n');
      if (!first.split(/,\s*/).some((spec) => head.test(spec.trim().replace(/^"/, '')))) continue;
      const match = /^\s+version:?\s+"?([^"\s]+)"?/m.exec(block);
      if (match && valid(match[1])) return match[1];
    }
  }
  return null;
}

function fromBunLock(text) {
  for (const name of PACKAGES) {
    const match = new RegExp(`"${escape(name)}":\\s*\\[\\s*"${escape(name)}@([^"]+)"`).exec(text);
    if (match && valid(match[1])) return match[1];
  }
  return null;
}

const LOCKFILES = [
  ['package-lock.json', fromPackageLock],
  ['npm-shrinkwrap.json', fromPackageLock],
  ['pnpm-lock.yaml', fromPnpmLock],
  ['yarn.lock', fromYarnLock],
  ['bun.lock', fromBunLock],
];

function fromNodeModules(dir) {
  for (const name of PACKAGES) {
    const file = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (!fs.existsSync(file)) continue;
    try {
      const version = valid(JSON.parse(fs.readFileSync(file, 'utf8')).version);
      if (version) return version;
    } catch {
      // A damaged package.json says nothing; keep looking.
    }
  }
  return null;
}

function findPlaywrightVersion(start, stop = null) {
  let dir = path.resolve(start);
  const end = stop ? path.resolve(stop) : null;
  for (;;) {
    const rel = path.relative(dir, path.resolve(start)).split(path.sep).join('/');
    for (const [file, read] of LOCKFILES) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      let version;
      try {
        version = read(fs.readFileSync(full, 'utf8'), rel);
      } catch {
        version = null;
      }
      if (version) return { version, source: full };
    }
    const installed = fromNodeModules(dir);
    if (installed) return { version: installed, source: path.join(dir, 'node_modules') };
    const parent = path.dirname(dir);
    if (parent === dir || (end && dir === end)) return { version: null, source: null };
    dir = parent;
  }
}

/** The version of Playwright installed for `cwd`, as Node resolves it from there, or null. */
function installedPlaywrightVersion(cwd) {
  for (const name of PACKAGES) {
    try {
      const file = require.resolve(`${name}/package.json`, { paths: [path.resolve(cwd)] });
      const version = valid(JSON.parse(fs.readFileSync(file, 'utf8')).version);
      if (version) return version;
    } catch {
      // Not installed under this name.
    }
  }
  return null;
}

module.exports = {
  findPlaywrightVersion,
  fromBunLock,
  fromPackageLock,
  fromPnpmLock,
  fromYarnLock,
  installedPlaywrightVersion,
};
