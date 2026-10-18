/**
 * The pin under the race the service allows: shard jobs that start at once, while other runs
 * publish newer history entries between their reads. The artifact and cache models
 * (tests/support/model.js) behave as GitHub's services were measured to: one name uploaded by
 * several jobs at once creates an artifact for each, and of several concurrent saves of one cache
 * key exactly one creates it. Every shard must plan from the same bytes, or a test could run twice
 * or not at all.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { actionInputs, readInputs, ACTION_INPUTS } = require('../lib/inputs');
const { pin } = require('../lib/pin');
const { applyRun, emptyHistory, serializeHistory } = require('../lib/history');
const { cacheKey } = require('../lib/identity');
const { testKey } = require('../lib/plan/estimate');
const { FIXTURE } = require('./support/fixture');
const { cacheSave, modelArtifacts, modelCache, newWorld } = require('./support/model');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function workspace() {
  const ws = tmp('psp-race-');
  fs.mkdirSync(path.join(ws, 'app'));
  fs.writeFileSync(path.join(ws, 'app', 'package.json'), '{}');
  fs.copyFileSync(
    path.join(FIXTURE, 'package-lock.json'),
    path.join(ws, 'app', 'package-lock.json')
  );
  return ws;
}

const historyOf = (key, run) =>
  serializeHistory(
    applyRun(emptyHistory(key), {
      id: run,
      attempt: 1,
      commit: 'c',
      fingerprint: 'f',
      date: '2026-10-16',
      workers: 1,
      samples: new Map([[testKey('chromium', 'a.spec.js', [`run ${run}`]), 100 + run]]),
    }).history
  );

const SHARDS = 8;

test('eight shards that pin at once while the history moves all plan from the same bytes', async () => {
  const spaces = Array.from({ length: SHARDS }, workspace);
  const prepared = (ws) =>
    actionInputs(
      { ...readInputs(ACTION_INPUTS, {}), 'working-directory': 'app' },
      { GITHUB_WORKSPACE: ws, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' }
    );
  const { key } = prepared(spaces[0]);
  const world = newWorld();
  cacheSave(world, cacheKey(key, 1, 1), { 'history.json': Buffer.from(historyOf(key, 1)) });
  // Another run publishes a newer entry before every read of the newest history, one tick apart,
  // so each shard that reads the history reads a newer entry than the shard before it.
  let seq = 1;
  let reads = 0;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  world.before = async (op, name) => {
    if (op === 'restore' && name.startsWith('psp-history-')) {
      for (let i = reads++; i > 0; i--) await tick();
      seq += 1;
      cacheSave(world, cacheKey(key, 1, seq), {
        'history.json': Buffer.from(historyOf(key, seq)),
      });
    }
  };
  const pins = await Promise.all(
    spaces.map((ws) =>
      pin({
        prepared: { ...prepared(ws), workspace: ws },
        runId: 7,
        job: 'test',
        cache: modelCache(world, ws),
        artifacts: modelArtifacts(world, 7),
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
      })
    )
  );
  assert.ok(seq > 2, 'the history moved while the shards pinned');
  const distinct = new Set(pins.map((p) => JSON.stringify(p)));
  assert.strictEqual(
    distinct.size,
    1,
    `the shards planned from ${distinct.size} snapshots: ${[...new Set(pins.map((p) => p.matchedKey))].join(', ')}`
  );
});
