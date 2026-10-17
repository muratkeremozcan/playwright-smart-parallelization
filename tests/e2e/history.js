'use strict';

/**
 * Helpers of the end-to-end jobs in `.github/workflows/e2e-pipeline.yml`, run against the real
 * Actions cache folder of the Action (`.psp/history`):
 *
 *   node tests/e2e/history.js key                 print the history key, its cache prefix and the
 *                                                 pin cache key of JOB in GITHUB_RUN_ID, from the
 *                                                 INPUT_* inputs the Action reads, to seed or
 *                                                 inspect a history
 *   node tests/e2e/history.js seed KEY RUN_ID     write a valid history of one synthetic run and
 *                                                 print its sha
 *   node tests/e2e/history.js sha                 print the sha of the restored history
 *   node tests/e2e/history.js expect-samples RUN_ID RECORDS_DIR [EXCLUDED]
 *                                                 fail unless the restored history holds exactly
 *                                                 one sample of RUN_ID for every test that passed
 *                                                 in the records, and none for a test whose title
 *                                                 contains EXCLUDED
 *   node tests/e2e/history.js publishers RUN_ID RECORDS_DIR
 *                                                 print how many shards of RUN_ID had a passing
 *                                                 test, so published an entry of their own
 *   node tests/e2e/history.js expect-runs ID...   fail unless the restored history holds these runs
 *   node tests/e2e/history.js expect-pin RUN_ID RECORDS_DIR
 *                                                 fail unless every record of job test in RUN_ID
 *                                                 planned from the restored pin: balanced from its
 *                                                 bytes, or native when it holds no usable history
 *   node tests/e2e/history.js wait-until AT MS    sleep until MS milliseconds after the Unix time
 *                                                 AT, to the millisecond; when it passed more than
 *                                                 two seconds ago, warn and print late=true
 */

const fs = require('node:fs');
const path = require('node:path');
const { applyRun, emptyHistory, parseHistory, serializeHistory } = require('../../lib/history');
const {
  CACHE_PATH,
  HISTORY_FILE,
  PIN_FILE,
  PIN_PATH,
  cachePrefix,
  pinKey,
} = require('../../lib/identity');
const { decide } = require('../../lib/setup');
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

function expectPin(runId, dir) {
  const id = Number(runId);
  const pinned = JSON.parse(
    fs.readFileSync(
      path.join(process.env.GITHUB_WORKSPACE || process.cwd(), PIN_PATH, PIN_FILE),
      'utf8'
    )
  );
  const decided = decide(pinned, pinned.key);
  const expected = decided.mode === 'balanced' ? `balanced from ${decided.sha}` : decided.mode;
  const mine = records(dir).filter((r) => r.run.id === id && r.job === 'test');
  if (!mine.length) fail(`no record of job test in run ${id}`);
  for (const r of mine) {
    const planned = r.mode === 'balanced' ? `balanced from ${r.snapshotSha}` : r.mode;
    if (planned !== expected) {
      fail(
        `shard ${r.shard.current}/${r.shard.total} of attempt ${r.run.attempt} planned ${planned}; ` +
          `the pin says ${expected}`
      );
    }
  }
  process.stdout.write(
    `${mine.length} shard records planned from the pin of ${pinned.matchedKey || 'no history'}: ${expected}\n`
  );
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
      `pin=${pinKey(key, process.env.JOB || 'test', process.env.GITHUB_RUN_ID)}\n`
  );
} else if (command === 'seed') seed(args[0], args[1]);
else if (command === 'sha') process.stdout.write(`sha=${sha256(fs.readFileSync(file, 'utf8'))}\n`);
else if (command === 'expect-samples') expectSamples(args[0], args[1], args[2]);
else if (command === 'publishers') {
  const id = Number(args[0]);
  const n = records(args[1]).filter((r) => r.run.id === id && r.tests.some((t) => t.sample_ms));
  process.stdout.write(`${n.length}\n`);
} else if (command === 'expect-runs') expectRuns(args);
else if (command === 'expect-pin') expectPin(args[0], args[1]);
else if (command === 'wait-until') {
  // Lines for the log go to stderr; stdout carries only the step output.
  const at = Number(args[0]) * 1000 + Number(args[1] || 0);
  const late = Date.now() - at;
  if (late > 2000) {
    process.stderr.write(`::warning::the moment passed ${late}ms ago\n`);
    process.stdout.write('late=true\n');
  } else {
    setTimeout(
      () => process.stderr.write(`waited until ${new Date(at).toISOString()}\n`),
      Math.max(0, -late)
    );
  }
} else fail(`unknown command ${command}`);
