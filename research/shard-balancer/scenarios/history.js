'use strict';

/**
 * What `update` does to the timings file (rows `h.*`): failed, cancelled, faster, filtered,
 * damaged, repeated and partial input, expiry, determinism and two runs racing to publish. The
 * inputs are the run records real fixture runs wrote; `update` runs on copies of the history.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { greenProject, redProject } = require('../../../qualification/lib/variants');
const drive = require('../drive');
const { median } = require('../lib/median');
const { row } = require('./row');

const DATE_SHIFT = path.resolve(__dirname, '..', 'lib', 'date-shift.js');
const VOLATILE = 'volatile.spec.js › volatile step';
const PROJECTS = ['chromium', 'firefox'];
const SLOW_FAILURE_MS = 3000;
const CANCEL_AFTER_MS = 300;
const FASTER_MS = 100;
const FASTER_RUNS = 3;
// The exit code of a Node process ended by SIGINT: 128 plus the signal number 2.
const SIGINT_EXIT = 130;

const keyOf = (project, test = VOLATILE) => `[${project}] › ${test}`;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// The sha `update` records for an input in the `applied` list.
const inputSha = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex').slice(0, 12);

// A test that fails slowly on its first attempt and passes on the retry, with the key of the
// volatile test, so its history is the history of the green variant.
const FLAKY_SLOW = `'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

test('volatile step', async ({}, testInfo) => {
  if (testInfo.retry === 0) {
    await sleep(Number(process.env.PSP_FAIL_AFTER_MS || 3000));
    throw new Error('the first attempt fails slowly');
  }
  await sleep(Number(process.env.PSP_VOLATILE_MS || 1000));
});
`;

/** One unsharded run of the volatile test of `cwd`, with a record. */
function volatileRun(ctx, { name, cwd, env = {}, json = false }) {
  const dir = ctx.dir(name);
  return ctx.runPartition({
    name,
    cwd,
    workers: 1,
    forward: ['--grep=volatile'],
    partition: [{ args: [], env: drive.shardEnv({ dir, index: 1, env, json }) }],
  });
}

/**
 * A copy of the green history whose volatile entries hold a full window: the measured sample of
 * each project five times, as five runs of the same duration would leave it.
 */
function fullWindow(ctx, name) {
  const file = ctx.timingsCopy(name, greenHistory(ctx).timings);
  const timings = drive.readTimings(file);
  for (const project of PROJECTS) {
    const entry = timings.tests[keyOf(project)];
    if (!entry) throw new Error(`the green history has no ${keyOf(project)}`);
    entry.samples = Array(5).fill(entry.samples[entry.samples.length - 1]);
  }
  fs.writeFileSync(file, `${JSON.stringify(timings, null, 1)}\n`);
  return file;
}

/** Whether the volatile samples of both projects exist and did not change. */
const unchanged = (before, after) =>
  PROJECTS.every((p) => Array.isArray(before[p]) && before[p].length > 0) &&
  JSON.stringify(before) === JSON.stringify(after);

/** The green variant run natively over two shards and the history `update` built from it. */
function greenHistory(ctx) {
  return ctx.baseline({ name: 'green-2', cwd: greenProject(ctx) });
}

/** The samples of the volatile test per project in a timings file. */
function volatileSamples(file) {
  return Object.fromEntries(PROJECTS.map((p) => [p, drive.samplesOf(file, keyOf(p))]));
}

/** `update` of a fresh copy of the green history with the record of `run`. */
function updateCopy(ctx, name, run, base = greenHistory(ctx).timings) {
  const timings = ctx.timingsCopy(name, base);
  const before = volatileSamples(timings);
  const call = drive.update(
    timings,
    run.records.filter(Boolean).map((r) => r.file)
  );
  return { timings, before, after: volatileSamples(timings), call };
}

function failedSlow(ctx) {
  const run = volatileRun(ctx, {
    name: 'red-slow',
    cwd: redProject(ctx),
    env: { PSP_FAIL_AFTER_MS: String(SLOW_FAILURE_MS) },
  });
  const merged = updateCopy(ctx, 'red-slow', run);
  const test = run.records[0].data.tests.find((t) => t.key === keyOf('chromium'));
  const facts = {
    exitCode: run.raw[0].exitCode,
    failedMs: test.duration_ms,
    outcome: test.outcome,
    updateExit: merged.call.status,
    before: merged.before,
    after: merged.after,
  };
  return row(
    'h.failed-slow',
    'A failed run adds no sample, however long the failure took.',
    facts.updateExit === 0 && unchanged(facts.before, facts.after),
    facts,
    `The volatile test failed after ${SLOW_FAILURE_MS} ms on each of its attempts (${facts.failedMs} ms in chromium, outcome \`${facts.outcome}\`). After \`update\` its samples are ${facts.after.chromium.join(', ')} ms in chromium and ${facts.after.firefox.join(', ')} ms in firefox, as before.`
  );
}

function cancelled(ctx) {
  const run = volatileRun(ctx, {
    name: 'green-cancelled',
    cwd: greenProject(ctx),
    env: { PSP_CANCEL_AFTER_MS: String(CANCEL_AFTER_MS) },
  });
  const record = run.records[0];
  const merged = record ? updateCopy(ctx, 'green-cancelled', run) : null;
  const test = record && record.data.tests.find((t) => t.key === keyOf('chromium'));
  const facts = {
    exitCode: run.raw[0].exitCode,
    recordWritten: Boolean(record),
    status: record && record.data.status,
    ran: test ? test.ran : null,
    before: merged && merged.before,
    after: merged && merged.after,
  };
  return row(
    'h.cancelled',
    'A cancelled run adds no sample for the interrupted test.',
    facts.exitCode === SIGINT_EXIT &&
      facts.recordWritten &&
      facts.ran === false &&
      merged !== null &&
      unchanged(facts.before, facts.after),
    facts,
    `SIGINT ${CANCEL_AFTER_MS} ms into the test: exit ${facts.exitCode}, the record says \`${facts.status}\` and marks the test as not run, and \`update\` leaves its samples at ${facts.after ? facts.after.chromium.join(', ') : 'none'} ms in chromium.`
  );
}

function fasterTest(ctx) {
  const timings = fullWindow(ctx, 'faster');
  const prices = [median(drive.samplesOf(timings, keyOf('chromium')))];
  for (let n = 1; n <= FASTER_RUNS; n += 1) {
    const run = volatileRun(ctx, {
      name: `green-fast-${n}`,
      cwd: greenProject(ctx),
      env: { PSP_VOLATILE_MS: String(FASTER_MS) },
    });
    const call = drive.update(
      timings,
      run.records.filter(Boolean).map((r) => r.file)
    );
    if (call.status !== 0) throw new Error(`update failed: ${call.stderr}`);
    prices.push(median(drive.samplesOf(timings, keyOf('chromium'))));
  }
  const facts = { pricesMs: prices, samples: drive.samplesOf(timings, keyOf('chromium')) };
  return row(
    'h.faster-test',
    'From a full window, the price of a test that got faster follows it in three runs.',
    prices[prices.length - 1] < 2 * FASTER_MS + 50 &&
      prices.slice(0, -1).every((price) => price > 5 * FASTER_MS),
    facts,
    `The volatile test went from about one second to ${FASTER_MS} ms, starting from a window of five samples. Its chromium price before and after each of ${FASTER_RUNS} faster runs: ${prices.join(' then ')} ms (samples ${facts.samples.join(', ')}). The median of the last five drops once the fast samples are the majority.`
  );
}

function flakySlow(ctx) {
  const run = volatileRun(ctx, {
    name: 'flaky-slow',
    cwd: ctx.once('variant:flaky-slow', () =>
      ctx.copy('variant-flaky-slow', { 'tests/volatile.spec.js': FLAKY_SLOW })
    ),
    env: { PSP_FAIL_AFTER_MS: String(SLOW_FAILURE_MS) },
    json: true,
  });
  const record = run.records[0];
  const test = record && record.data.tests.find((t) => t.key === keyOf('chromium'));
  const report = JSON.parse(fs.readFileSync(path.join(run.dir, 'report-1.json'), 'utf8'));
  const results = [];
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests) if (t.projectName === 'chromium') results.push(...t.results);
    }
    (suite.suites || []).forEach(visit);
  };
  report.suites.forEach(visit);
  const passing = results.find((r) => r.status === 'passed');
  const short = updateCopy(ctx, 'flaky-short', run);
  const fullFile = fullWindow(ctx, 'flaky-full');
  const fullBefore = median(drive.samplesOf(fullFile, keyOf('chromium')));
  const fullCall = drive.update(fullFile, [record.file]);
  const facts = {
    outcome: test ? test.outcome : null,
    attempts: results.length,
    sampleMs: test ? test.duration_ms : null,
    passingAttemptMs: passing ? passing.duration : null,
    shortWindowPriceMs: [median(short.before.chromium), median(short.after.chromium)],
    fullWindowPriceMs: [fullBefore, median(drive.samplesOf(fullFile, keyOf('chromium')))],
    updateExits: [short.call.status, fullCall.status],
  };
  const inflated = facts.sampleMs >= facts.passingAttemptMs + SLOW_FAILURE_MS * 0.9;
  return row(
    'h.flaky-slow',
    'A flaky result adds one sample with every attempt summed, so a slow failed attempt inflates it, and the median of a full window absorbs one such sample.',
    facts.outcome === 'flaky' &&
      inflated &&
      facts.updateExits.every((c) => c === 0) &&
      facts.shortWindowPriceMs[1] > facts.shortWindowPriceMs[0] &&
      facts.fullWindowPriceMs[0] === facts.fullWindowPriceMs[1],
    facts,
    `The first attempt failed after ${SLOW_FAILURE_MS} ms and the retry passed in ${facts.passingAttemptMs} ms; the record gives one sample of ${facts.sampleMs} ms. From the one-sample history the chromium price moves from ${facts.shortWindowPriceMs[0]} to ${facts.shortWindowPriceMs[1]} ms; from a full window it stays at ${facts.fullWindowPriceMs[1]} ms.`
  );
}

function damagedHistory(ctx) {
  const base = ctx.baseline();
  const text = fs.readFileSync(base.timings, 'utf8');
  const truncated = path.join(ctx.dir('damaged-history'), 'timings.json');
  fs.writeFileSync(truncated, text.slice(0, Math.floor(text.length / 2)));
  const truncatedSha = sha(truncated);
  const record = base.records[0].file;
  const onTruncated = drive.update(truncated, [record]);

  const good = ctx.timingsCopy('damaged-input');
  const goodSha = sha(good);
  const badInput = path.join(ctx.dir('damaged-input-record'), 'record.json');
  fs.writeFileSync(badInput, fs.readFileSync(record, 'utf8').slice(0, 200));
  const onBadInput = drive.update(good, [badInput]);

  const typed = path.join(ctx.dir('string-samples'), 'timings.json');
  const parsed = JSON.parse(text);
  const firstKey = Object.keys(parsed.tests)[0];
  parsed.tests[firstKey].samples = ['100'];
  fs.writeFileSync(typed, JSON.stringify(parsed));
  const typedSha = sha(typed);
  const onTyped = drive.update(typed, [record]);

  const first = (call) => call.stderr.split('\n')[0].replace(/^playwright-shard-balancer: /, '');
  const facts = {
    truncatedExit: onTruncated.status,
    truncatedUnchanged: sha(truncated) === truncatedSha,
    badInputExit: onBadInput.status,
    badInputUnchanged: sha(good) === goodSha,
    stringSamplesExit: onTyped.status,
    stringSamplesUnchanged: sha(typed) === typedSha,
    stringSamplesMessage: ctx.scrub(first(onTyped)).replace(/\S*timings\.json/, 'timings.json'),
  };
  return row(
    'h.damaged-history',
    '`update` with a damaged history file or a damaged input exits non-zero and leaves the history as it was.',
    [facts.truncatedExit, facts.badInputExit, facts.stringSamplesExit].every((c) => c !== 0) &&
      facts.truncatedUnchanged &&
      facts.badInputUnchanged &&
      facts.stringSamplesUnchanged,
    facts,
    `A truncated history exits ${facts.truncatedExit}, a truncated record exits ${facts.badInputExit}, and samples stored as text exit ${facts.stringSamplesExit} (\`${facts.stringSamplesMessage}\`); each history file keeps its bytes.`
  );
}

function duplicateInput(ctx) {
  const timings = ctx.timingsCopy('duplicate-input');
  const record = ctx.balanced(2).records[0].file;
  const first = drive.update(timings, [record]);
  const firstSha = sha(timings);
  const second = drive.update(timings, [record]);
  const facts = {
    firstSkipped: first.json.skipped_inputs,
    secondSkipped: second.json.skipped_inputs,
    secondSamples: second.json.samples,
    unchanged: sha(timings) === firstSha,
    warning: second.json.warnings[0] ? second.json.warnings[0].replace(/^.*: /, '') : null,
  };
  return row(
    'h.duplicate-input',
    '`update` skips an input it already merged, by the sha of its bytes.',
    facts.secondSkipped === 1 && facts.secondSamples === 0 && facts.unchanged,
    facts,
    `The same record merged twice: the second \`update\` skipped ${facts.secondSkipped} input with \`${facts.warning}\`, added ${facts.secondSamples} samples and left the file byte for byte as it was.`
  );
}

/** Two shards with `--grep=cart`, balanced from the baseline, with records. */
function filteredRun(ctx) {
  return ctx.run({
    name: 'filtered-cart-2',
    shards: 2,
    timings: ctx.baseline().timings,
    forward: ['--grep=cart'],
  });
}

function filtered(ctx) {
  const timings = ctx.timingsCopy('filtered');
  const before = drive.readTimings(timings).tests;
  const call = drive.update(
    timings,
    filteredRun(ctx)
      .records.filter(Boolean)
      .map((r) => r.file)
  );
  const after = drive.readTimings(timings).tests;
  const sampled = new Set(
    filteredRun(ctx)
      .records.filter(Boolean)
      .flatMap((r) => r.data.tests.filter((t) => t.ran).map((t) => t.key))
  );
  const untouched = Object.keys(before).filter((key) => !sampled.has(key));
  const facts = {
    updateExit: call.status,
    entriesBefore: Object.keys(before).length,
    entriesAfter: Object.keys(after).length,
    sampledByRun: sampled.size,
    otherEntriesKept: untouched.every(
      (key) => JSON.stringify(before[key]) === JSON.stringify(after[key])
    ),
    cartSamples: after[keyOf('chromium', 'cart.spec.js › cart › adds an item')].samples.length,
    perProjectEntries: PROJECTS.every((p) =>
      Boolean(after[keyOf(p, 'cart.spec.js › cart › adds an item')])
    ),
  };
  return row(
    'h.filtered-run',
    '`update` from a filtered run keeps the entries of the tests the run left out.',
    facts.updateExit === 0 &&
      facts.entriesAfter === facts.entriesBefore &&
      facts.otherEntriesKept &&
      facts.perProjectEntries,
    facts,
    `After a \`--grep=cart\` run the history has ${facts.entriesAfter} entries, as before (${facts.entriesBefore}). The ${facts.sampledByRun} entries the run sampled gained a sample (a cart test now has ${facts.cartSamples}) and every other entry kept its bytes. The cart test has its own entry in each browser project (${facts.perProjectEntries}).`
  );
}

function expiry(ctx) {
  const inputs = filteredRun(ctx)
    .records.filter(Boolean)
    .map((r) => r.file);
  const counts = {};
  for (const days of [30, 31]) {
    const timings = ctx.timingsCopy(`expiry-${days}`);
    const call = drive.update(timings, inputs, {
      env: { NODE_OPTIONS: `--require ${DATE_SHIFT}`, PSP_DATE_SHIFT_DAYS: String(days) },
    });
    if (call.status !== 0) throw new Error(`update failed: ${call.stderr}`);
    counts[days] = Object.keys(drive.readTimings(timings).tests).length;
  }
  const sampled = new Set(
    inputs.flatMap((file) =>
      JSON.parse(fs.readFileSync(file, 'utf8'))
        .tests.filter((t) => t.ran)
        .map((t) => t.key)
    )
  ).size;
  const facts = {
    entriesBefore: Object.keys(drive.readTimings(ctx.baseline().timings).tests).length,
    after30Days: counts[30],
    after31Days: counts[31],
    sampledByRun: sampled,
  };
  return row(
    'h.expiry',
    'An entry no update has seen for more than 30 days is dropped, so a test filtered out for a month loses its history.',
    facts.after30Days === facts.entriesBefore && facts.after31Days === facts.sampledByRun,
    facts,
    `A \`--grep=cart\` update ${30} days after the history was written keeps ${facts.after30Days} of ${facts.entriesBefore} entries; ${31} days after, ${facts.after31Days} are left, the tests that run sampled.`
  );
}

function setupOnce(ctx) {
  const base = ctx.baseline();
  const key = '[setup] › global.setup.js › prepare the environment';
  const shardsWithSetup = base.records.filter((r) =>
    r.data.tests.some((t) => t.key === key && t.ran)
  ).length;
  const facts = { shardsWithSetup, samples: drive.samplesOf(base.timings, key).length };
  return row(
    'h.setup-once',
    'A setup test every shard ran gives one sample per update.',
    facts.shardsWithSetup === 2 && facts.samples === 1,
    facts,
    `Both shards of the native run ran the setup project (${facts.shardsWithSetup} records), and the history built from them holds ${facts.samples} sample for it.`
  );
}

function missingShardUpdate(ctx) {
  const timings = ctx.timingsCopy('missing-shard');
  const run = ctx.balanced(2);
  const call = drive.update(timings, [run.records[0].file]);
  const facts = {
    updateExit: call.status,
    inputs: call.json.inputs,
    shards: run.records.length,
    samples: call.json.samples,
    warnings: call.json.warnings.length,
  };
  return row(
    'h.missing-shard-update',
    '`update` refuses the records of fewer shards than ran.',
    facts.updateExit !== 0,
    facts,
    `The record of one of ${facts.shards} shards: \`update\` exits ${facts.updateExit}, merges ${facts.samples} samples and prints ${facts.warnings} warnings. The finish action runs \`update\` before \`check\` and saves when \`update\` succeeds.`
  );
}

function deterministicBytes(ctx) {
  const [one, two] = ctx.balanced(2).records.map((r) => r.file);
  const copies = ['a', 'b', 'c'].map((name) => ctx.timingsCopy(`bytes-${name}`));
  const calls = [
    drive.update(copies[0], [one, two]),
    drive.update(copies[1], [one, two]),
    drive.update(copies[2], [two, one]),
  ];
  const withoutApplied = (file) =>
    JSON.stringify({ ...drive.readTimings(file), applied: undefined });
  const keys = Object.keys(drive.readTimings(copies[0]).tests);
  const facts = {
    shas: calls.map((call) => call.json.sha),
    sameOrderSameBytes: sha(copies[0]) === sha(copies[1]),
    otherOrderSameBytes: sha(copies[0]) === sha(copies[2]),
    otherOrderSameEntries: withoutApplied(copies[0]) === withoutApplied(copies[2]),
    keysSorted: keys.every((key, i) => i === 0 || keys[i - 1] < key),
  };
  return row(
    'h.deterministic-bytes',
    'The same inputs in the same order give the same bytes and sha with sorted keys; another order changes only the order of the `applied` list.',
    facts.sameOrderSameBytes && facts.keysSorted && facts.otherOrderSameEntries,
    facts,
    `Two copies updated with the shard records in one order give \`${facts.shas[0]}\` and \`${facts.shas[1]}\`; the opposite order gives \`${facts.shas[2]}\`, with the same entries (${facts.otherOrderSameEntries}) and the input shas listed in the other order. A writer that sorts its inputs gets the same bytes every time.`
  );
}

/**
 * A model of the GitHub Actions cache as the actions use it: entries are immutable, an exact key
 * hit wins, and a prefix in `restore-keys` returns the most recently created matching entry.
 */
function cacheModel() {
  const entries = [];
  return {
    save(key, file) {
      if (entries.some((e) => e.key === key)) return false;
      entries.push({ key, bytes: fs.readFileSync(file), order: entries.length });
      return true;
    },
    restore(key, prefix, target) {
      const exact = entries.find((e) => e.key === key);
      const match =
        exact ||
        entries.filter((e) => e.key.startsWith(prefix)).sort((x, y) => y.order - x.order)[0];
      if (!match) return null;
      fs.writeFileSync(target, match.bytes);
      return match.key;
    },
  };
}

/** Two finish jobs that both restore the same history, then save in the opposite order. */
function race(ctx, name) {
  const cache = cacheModel();
  cache.save('pwsb-timings-100-1', ctx.baseline().timings);
  const older = ctx.balanced(2).records.map((r) => r.file);
  const newer = filteredRun(ctx)
    .records.filter(Boolean)
    .map((r) => r.file);
  const job = (run) => {
    const file = path.join(ctx.dir(`${name}-${run}`), 'timings.json');
    cache.restore(`pwsb-timings-${run}-1`, 'pwsb-timings-', file);
    return file;
  };
  const olderFile = job(101);
  const newerFile = job(102);
  drive.update(newerFile, newer);
  drive.update(olderFile, older);
  // The newer run's save lands first; the older run was delayed and saves after it.
  cache.save('pwsb-timings-102-1', newerFile);
  cache.save('pwsb-timings-101-1', olderFile);
  const next = path.join(ctx.dir(`${name}-next`), 'timings.json');
  const restored = cache.restore('pwsb-timings-103-1', 'pwsb-timings-', next);
  return { restored, next, newerFile, olderFile, older, newer };
}

/** The history one writer gets by merging the newer run and then the older one, in sequence. */
function sequential(ctx, name, { older, newer }) {
  const timings = ctx.timingsCopy(name);
  const steps = [drive.update(timings, newer), drive.update(timings, older)];
  return { timings, steps };
}

function racingPublish(ctx) {
  const raced = race(ctx, 'race');
  const published = drive.readTimings(raced.next);
  const serial = drive.readTimings(sequential(ctx, 'race-sequential', raced).timings);
  const lost = Object.keys(serial.tests).filter(
    (key) =>
      !published.tests[key] ||
      published.tests[key].samples.length < serial.tests[key].samples.length
  );
  const newerShas = raced.newer.map(inputSha);
  const facts = {
    restoredKey: raced.restored,
    lostEntries: lost.length,
    newerRunApplied: newerShas.every((s) => (published.applied || []).includes(s)),
  };
  return row(
    'h.racing-publish',
    'Two runs racing to publish never lose the updates of either.',
    facts.lostEntries === 0,
    facts,
    `Runs 101 and 102 both restored the same history and the older run saved last. The next run restores \`${facts.restoredKey}\`, the most recently created entry: against merging both runs in sequence it lacks a sample in ${facts.lostEntries} entries, and its \`applied\` list does not hold the newer run's records (${facts.newerRunApplied}).`
  );
}

function remergeUnion(ctx) {
  const { older, newer } = race(ctx, 'remerge');
  const { timings, steps } = sequential(ctx, 'remerge', { older, newer });
  const unionSha = sha(timings);
  const again = drive.update(timings, older);
  const merged = drive.readTimings(timings).tests;
  const cartKey = keyOf('chromium', 'cart.spec.js › cart › adds an item');
  const facts = {
    exits: [...steps, again].map((call) => call.status),
    replaySkipped: again.json.skipped_inputs,
    unchanged: sha(timings) === unionSha,
    cartSamples: merged[cartKey].samples.length,
  };
  return row(
    'h.remerge-union',
    'One writer that merges every run into the newest history keeps the updates of both runs, and a replayed run changes nothing.',
    facts.exits.every((c) => c === 0) &&
      facts.replaySkipped === older.length &&
      facts.unchanged &&
      facts.cartSamples === 3,
    facts,
    `The writer merged the newer run and then the older one into one history: a cart test holds ${facts.cartSamples} samples, one from the baseline and one from each run. Replaying the older run skipped ${facts.replaySkipped} inputs and kept the bytes.`
  );
}

function historyRows(ctx) {
  return [
    failedSlow(ctx),
    cancelled(ctx),
    fasterTest(ctx),
    flakySlow(ctx),
    damagedHistory(ctx),
    duplicateInput(ctx),
    filtered(ctx),
    expiry(ctx),
    setupOnce(ctx),
    missingShardUpdate(ctx),
    deterministicBytes(ctx),
    racingPublish(ctx),
    remergeUnion(ctx),
  ];
}

module.exports = { cacheModel, historyRows };
