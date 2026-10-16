/**
 * Reading the Playwright version before install, from each package manager's lockfile or an
 * installed node_modules, searching up from the working directory.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  findPlaywrightVersion,
  fromBunLock,
  fromPackageLock,
  fromPnpmLock,
  fromYarnLock,
  installedPlaywrightVersion,
} = require('../lib/playwright-version');
const { FIXTURE } = require('./support/fixture');

test('npm lockfile, v3 and v1', () => {
  assert.strictEqual(
    fromPackageLock(
      JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.64.1' } } })
    ),
    '1.64.1'
  );
  assert.strictEqual(
    fromPackageLock(JSON.stringify({ dependencies: { playwright: { version: '1.63.0' } } })),
    '1.63.0'
  );
});

test('pnpm lockfile, v6 and v9', () => {
  assert.strictEqual(
    fromPnpmLock('packages:\n\n  /@playwright/test@1.64.1:\n    resolution: {}\n'),
    '1.64.1'
  );
  assert.strictEqual(
    fromPnpmLock("packages:\n\n  '@playwright/test@1.63.2':\n    resolution: {}\n"),
    '1.63.2'
  );
});

test('yarn lockfile, classic and berry', () => {
  assert.strictEqual(fromYarnLock('"@playwright/test@^1.64.0":\n  version "1.64.1"\n'), '1.64.1');
  assert.strictEqual(
    fromYarnLock('"@playwright/test@npm:^1.64.0":\n  version: 1.64.1\n  resolution: x\n'),
    '1.64.1'
  );
});

test('bun lockfile', () => {
  assert.strictEqual(
    fromBunLock('{ "packages": { "@playwright/test": ["@playwright/test@1.64.1", "", {}] } }'),
    '1.64.1'
  );
});

test('searches up from the working directory and stops at the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-version-'));
  const app = path.join(root, 'packages', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'yarn.lock'),
    '"@playwright/test@^1.64.0":\n  version "1.64.1"\n'
  );
  assert.deepStrictEqual(findPlaywrightVersion(app, root), {
    version: '1.64.1',
    source: path.join(root, 'yarn.lock'),
  });
  assert.deepStrictEqual(findPlaywrightVersion(app, path.join(root, 'packages')), {
    version: null,
    source: null,
  });
});

test('reads the fixture lockfile and its installed version', () => {
  const found = findPlaywrightVersion(FIXTURE, FIXTURE);
  assert.match(found.version, /^1\.\d+\.\d+$/);
  assert.strictEqual(installedPlaywrightVersion(FIXTURE), found.version);
  assert.strictEqual(installedPlaywrightVersion(os.tmpdir()), null);
});
