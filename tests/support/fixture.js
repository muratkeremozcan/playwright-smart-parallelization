/**
 * The consumer fixture and its real Playwright. Tests list and run it for real: nothing here
 * imitates Playwright. `npm ci` in `fixtures/consumer` installs it; a missing install fails the
 * test with that instruction instead of skipping.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listIntended } = require('../../harness/index.js');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'consumer');

function requireFixture() {
  if (!fs.existsSync(path.join(FIXTURE, 'node_modules', '@playwright', 'test'))) {
    throw new Error('the consumer fixture is not installed: run `npm ci` in fixtures/consumer');
  }
  return FIXTURE;
}

const cache = new Map();

/** `listIntended` on the fixture, memoized per options. Returns `{ leaves, dependencies }`. */
function listFixture(options = {}) {
  const key = JSON.stringify(options);
  if (!cache.has(key)) cache.set(key, listIntended({ cwd: requireFixture(), ...options }));
  return cache.get(key);
}

module.exports = { FIXTURE, listFixture, requireFixture };
