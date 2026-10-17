'use strict';

/**
 * Helpers of the end-to-end jobs in `.github/workflows/e2e-pipeline.yml`, run against the real
 * Actions cache folder of the Action (`.psp/history`):
 *
 *   node tests/e2e/history.js key                 print the history key, its cache prefix and the
 *                                                 pin key of JOB, from the INPUT_* inputs the
 *                                                 Action reads, to seed or inspect a history
 *   node tests/e2e/history.js seed KEY RUN_ID     write a valid history of one synthetic run and
 *                                                 print its sha
 *   node tests/e2e/history.js sha                 print the sha of the restored history
 *   node tests/e2e/history.js expect-samples RUN_ID RECORDS_DIR [EXCLUDED]
 *                                                 fail unless the restored history holds exactly
 *                                                 one sample of RUN_ID for every test that passed
 *                                                 in the records, and none for a test whose title
 *                                                 contains EXCLUDED
 *   node tests/e2e/history.js expect-runs ID...   fail unless the restored history holds these runs
 */

const fs = require('node:fs');
const path = require('node:path');
const { applyRun, emptyHistory, parseHistory, serializeHistory } = require('../../lib/history');
const { CACHE_PATH, HISTORY_FILE, cachePrefix, pinKey } = require('../../lib/identity');
const { ACTION_INPUTS, actionInputs, readInputs } = require('../../lib/inputs');
const { testKey } = require('../../lib/plan/estimate');
const { sha256 } = require('../../lib/util');

const file = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), CACHE_PATH, HISTORY_FILE);
const fail = (message) => {
  process.stdout.write(`::error::${message}\n`);
  process.exitCode = 1;
};

function seed(key, runId) {
  const id = Number(runId);
  const { history } = applyRun(emptyHistory(key), {
    id,
    attempt: 1,
    commit: 'seeded',
    fingerprint: 'seeded',
    date: new Date().toISOString().slice(0, 10),
    samples: new Map([[testKey('chromium', 'seeded.spec.js', [`seeded run ${id}`]), 100]]),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeHistory(history));
  process.stdout.write(`sha=${sha256(serializeHistory(history))}\n`);
}

function records(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'record.json') out.push(JSON.parse(fs.readFileSync(full, 'utf8')));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function expectSamples(runId, dir, excluded) {
  const id = Number(runId);
  const history = parseHistory(fs.readFileSync(file, 'utf8'));
  const passed = new Set(
    records(dir)
      .filter((r) => r.run.id === id)
      .flatMap((r) => r.tests.filter((t) => t.sample_ms).map((t) => t.key))
  );
  if (!passed.size) fail(`no record of run ${id} has a passing test`);
  for (const key of passed) {
    const entry = history.tests[key];
    const mine = entry ? entry.samples.filter(([run]) => run === id).length : 0;
    if (mine !== 1) fail(`${key} has ${mine} samples of run ${id}, expected 1`);
  }
  for (const [key, entry] of Object.entries(history.tests)) {
    if (entry.samples.some(([run]) => run === id) && !passed.has(key)) {
      fail(`${key} has a sample of run ${id} but passed in no record`);
    }
    if (excluded && key.includes(excluded) && entry.samples.some(([run]) => run === id)) {
      fail(`${key} failed in run ${id} and has a sample of it`);
    }
  }
  process.stdout.write(`${passed.size} tests of run ${id}, one sample each\n`);
}

function expectRuns(ids) {
  const history = parseHistory(fs.readFileSync(file, 'utf8'));
  const missing = ids.map(Number).filter((id) => !history.runs.includes(id));
  process.stdout.write(`history runs: ${history.runs.join(', ')}\n`);
  if (missing.length) fail(`the history lacks runs ${missing.join(', ')}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'key') {
  const { key } = actionInputs(readInputs(ACTION_INPUTS), process.env);
  process.stdout.write(
    `key=${key}\nkey12=${key.slice(0, 12)}\nprefix=${cachePrefix(key)}\n` +
      `pin=${pinKey(key, process.env.GITHUB_RUN_ID, process.env.JOB || 'test')}\n`
  );
} else if (command === 'seed') seed(args[0], args[1]);
else if (command === 'sha') process.stdout.write(`sha=${sha256(fs.readFileSync(file, 'utf8'))}\n`);
else if (command === 'expect-samples') expectSamples(args[0], args[1], args[2]);
else if (command === 'expect-runs') expectRuns(args);
else fail(`unknown command ${command}`);
