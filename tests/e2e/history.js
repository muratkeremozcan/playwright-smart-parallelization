'use strict';

/**
 * Helpers of the end-to-end jobs in `.github/workflows/e2e-pipeline.yml`, run against the real
 * Actions cache folder of the Action (`.psp/history`):
 *
 *   node tests/e2e/history.js key              print the cache prefix prepare computes from the
 *                                              PSP_INPUT_* inputs, to seed a history before prepare
 *   node tests/e2e/history.js seed KEY RUN_ID   write a valid history of one synthetic run
 *   node tests/e2e/history.js expect-runs ID... fail unless the restored history holds these runs
 */

const fs = require('node:fs');
const path = require('node:path');
const { applyRun, emptyHistory, parseHistory, serializeHistory } = require('../../lib/history');
const { CACHE_PATH, HISTORY_FILE, cachePrefix } = require('../../lib/identity');
const { prepareInputs, readInputs } = require('../../lib/inputs');
const { testKey } = require('../../lib/plan/estimate');

const file = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), CACHE_PATH, HISTORY_FILE);

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
  process.stdout.write(`seeded run ${id} into ${file}\n`);
}

function expectRuns(ids) {
  const history = parseHistory(fs.readFileSync(file, 'utf8'));
  const missing = ids.map(Number).filter((id) => !history.runs.includes(id));
  process.stdout.write(`history runs: ${history.runs.join(', ')}\n`);
  if (missing.length) {
    process.stdout.write(`::error::the history lacks runs ${missing.join(', ')}\n`);
    process.exitCode = 1;
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'key') {
  const { key } = prepareInputs({ ...readInputs(), shards: '1', enabled: 'true' }, process.env);
  process.stdout.write(`key=${key}\nprefix=${cachePrefix(key)}\n`);
} else if (command === 'seed') seed(args[0], args[1]);
else if (command === 'expect-runs') expectRuns(args);
else {
  process.stdout.write(`::error::unknown command ${command}\n`);
  process.exitCode = 1;
}
