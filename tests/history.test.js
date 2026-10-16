/**
 * The history: validation, the run-id window, one sample per run, expiry, the union merge and one
 * byte form. Each case is a policy the history must keep, from the harvest's acceptance rows and
 * the G2 protocol cases of the review.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  EXPIRE_DAYS,
  MAX_RUNS,
  applyRun,
  emptyHistory,
  hasRun,
  mergeHistories,
  parseHistory,
  runSamples,
  serializeHistory,
} = require('../lib/history');
const { createEstimator, testKey } = require('../lib/plan/estimate');

const KEY = 'k';
const T = testKey('chromium', 'cart.spec.js', ['cart', 'adds an item']);
const U = testKey('chromium', 'cart.spec.js', ['cart', 'removes an item']);
const SETUP = testKey('setup', 'global.setup.js', ['prepare']);

const record = (tests) => ({ tests });
const t = (key, sampleMs, extra = {}) => ({
  id: `${key}#${extra.repeat || 0}`,
  key,
  repeat: 0,
  setup: false,
  outcome: 'expected',
  ran: true,
  sample_ms: sampleMs,
  ...extra,
});

const run = (id, samples, date = '2026-10-16') => ({
  id,
  attempt: 1,
  commit: `commit-${id}`,
  fingerprint: 'fp',
  date,
  samples: new Map(Object.entries(samples)),
});

function apply(history, ...runs) {
  return runs.reduce((h, r) => applyRun(h, r).history, history);
}

const price = (history, key) => createEstimator(history.tests).estimate({ key });

describe('validation', () => {
  const good = serializeHistory(apply(emptyHistory(KEY), run(1, { [T]: 100 })));

  test('accepts the canonical bytes of a valid history', () => {
    assert.strictEqual(parseHistory(good, { key: KEY }).runs[0], 1);
  });

  for (const [name, text] of [
    ['truncated', good.slice(0, 40)],
    ['samples as text', good.replace('[1,100]', '["1","100"]')],
    ['a 0 ms sample', good.replace('[1,100]', '[1,0]')],
    ['another schema', good.replace('playwright-smart-parallelization/history', 'other')],
    ['an unknown field', good.replace('"key":"k"', '"key":"k","extra":1')],
    ['unsorted runs', serializeHistory({ ...JSON.parse(good), runs: [2, 1] })],
    ['a key that is not a JSON title path', good.replace(JSON.stringify(T).slice(1, -1), 'plain')],
    ['pretty-printed bytes', `${JSON.stringify(JSON.parse(good), null, 2)}\n`],
  ]) {
    test(`refuses ${name}`, () => assert.throws(() => parseHistory(text, { key: KEY })));
  }

  test('refuses the history of another key', () => {
    assert.throws(() => parseHistory(good, { key: 'other' }), /belongs to history key k/);
  });
});

describe('samples of one run', () => {
  test('a failed test, a 0 ms pass and a test that did not run give no sample', () => {
    const samples = runSamples([
      record([
        t(T, null, { outcome: 'unexpected' }),
        t(U, 0),
        t(testKey('chromium', 'a.spec.js', ['x']), null, { ran: false, outcome: 'skipped' }),
      ]),
    ]);
    assert.deepStrictEqual([...samples], []);
  });

  test('a setup test every shard ran gives one sample: the median', () => {
    const samples = runSamples([
      record([t(SETUP, 50, { setup: true })]),
      record([t(SETUP, 70, { setup: true })]),
      record([t(SETUP, 90, { setup: true })]),
    ]);
    assert.deepStrictEqual([...samples], [[SETUP, 70]]);
  });

  test('the copies of --repeat-each give one sample per run', () => {
    const samples = runSamples([record([t(T, 100), t(T, 120, { repeat: 1 })])]);
    assert.deepStrictEqual([...samples], [[T, 110]]);
  });

  test('the order of the records does not change the samples', () => {
    const a = record([t(T, 100), t(SETUP, 50, { setup: true })]);
    const b = record([t(U, 200), t(SETUP, 60, { setup: true })]);
    assert.deepStrictEqual([...runSamples([a, b])], [...runSamples([b, a])]);
  });
});

describe('the window', () => {
  const full = () =>
    apply(emptyHistory(KEY), ...[1, 2, 3, 4, 5].map((id) => run(id, { [T]: 1000 })));

  test('three faster runs on a full window bring the price to the new duration', () => {
    const history = apply(full(), run(6, { [T]: 100 }), run(7, { [T]: 105 }));
    assert.strictEqual(price(history, T), 1000);
    assert.strictEqual(price(apply(history, run(8, { [T]: 98 })), T), 105);
  });

  test('a slow failure adds nothing, so the price stays', () => {
    const samples = runSamples([record([t(T, null, { outcome: 'unexpected' })])]);
    const history = apply(full(), run(6, Object.fromEntries(samples)));
    assert.strictEqual(price(history, T), 1000);
    assert.deepStrictEqual(
      history.tests[T].samples.map((s) => s[0]),
      [1, 2, 3, 4, 5]
    );
  });

  test('three passes of 0 ms leave the price as it was', () => {
    let history = full();
    for (const id of [6, 7, 8])
      history = apply(history, run(id, Object.fromEntries(runSamples([record([t(T, 0)])]))));
    assert.strictEqual(price(history, T), 1000);
  });

  test('a delayed older run never displaces newer samples, and replaying it changes no byte', () => {
    const newer = apply(
      emptyHistory(KEY),
      ...[102, 103, 104, 105, 106].map((id) => run(id, { [T]: 200 }))
    );
    const late = applyRun(newer, run(101, { [T]: 5000 }));
    assert.ok(late.applied);
    assert.deepStrictEqual(
      late.history.tests[T].samples.map((s) => s[0]),
      [102, 103, 104, 105, 106]
    );
    assert.ok(late.history.runs.includes(101));
    const again = applyRun(late.history, run(101, { [T]: 5000 }));
    assert.strictEqual(again.applied, false);
    assert.strictEqual(serializeHistory(again.history), serializeHistory(late.history));
  });

  test('an older run enters a window that is not full, ordered by run id', () => {
    const history = apply(emptyHistory(KEY), run(102, { [T]: 200 }), run(101, { [T]: 300 }));
    assert.deepStrictEqual(history.tests[T].samples, [
      [101, 300],
      [102, 200],
    ]);
  });

  test('two runs give the same bytes in either order', () => {
    const a = run(101, { [T]: 100, [U]: 300 });
    const b = run(102, { [T]: 120 });
    assert.strictEqual(
      serializeHistory(apply(emptyHistory(KEY), a, b)),
      serializeHistory(apply(emptyHistory(KEY), b, a))
    );
  });

  test('the source names the newest run, its commit and fingerprint', () => {
    const history = apply(emptyHistory(KEY), run(102, { [T]: 1 }), run(101, { [T]: 1 }));
    assert.deepStrictEqual(history.source, {
      run: 102,
      attempt: 1,
      commit: 'commit-102',
      fingerprint: 'fp',
      date: '2026-10-16',
    });
  });
});

describe('entries a run did not sample', () => {
  test('are kept by a run that left them out', () => {
    const history = apply(emptyHistory(KEY), run(1, { [T]: 100, [U]: 200 }), run(2, { [T]: 110 }));
    assert.deepStrictEqual(history.tests[U].samples, [[1, 200]]);
  });

  test(`drop after ${EXPIRE_DAYS} days unseen, so a deleted or renamed test leaves`, () => {
    const base = apply(emptyHistory(KEY), run(1, { [T]: 100, [U]: 200 }, '2026-09-15'));
    const kept = apply(base, run(2, { [T]: 100 }, '2026-10-15'));
    const dropped = apply(base, run(2, { [T]: 100 }, '2026-10-16'));
    assert.ok(kept.tests[U]);
    assert.strictEqual(dropped.tests[U], undefined);
  });

  test('a renamed test is new: priced by the median of its describe until it has samples', () => {
    const renamed = testKey('chromium', 'cart.spec.js', ['cart', 'adds two items']);
    const history = apply(emptyHistory(KEY), run(1, { [T]: 100, [U]: 300 }));
    assert.strictEqual(price(history, renamed), 200);
  });
});

describe('the union merge', () => {
  const a = apply(emptyHistory(KEY), run(1, { [T]: 100 }), run(3, { [U]: 300 }));
  const b = apply(emptyHistory(KEY), run(2, { [T]: 200 }));

  test('is commutative and idempotent, and keeps the samples of both', () => {
    const ab = serializeHistory(mergeHistories(a, b));
    assert.strictEqual(ab, serializeHistory(mergeHistories(b, a)));
    assert.strictEqual(serializeHistory(mergeHistories(a, a)), serializeHistory(a));
    assert.strictEqual(serializeHistory(mergeHistories(mergeHistories(a, b), b)), ab);
    assert.deepStrictEqual(JSON.parse(ab).tests[T].samples, [
      [1, 100],
      [2, 200],
    ]);
    assert.deepStrictEqual(JSON.parse(ab).runs, [1, 2, 3]);
  });

  test('refuses histories of two keys', () => {
    assert.throws(() => mergeHistories(a, emptyHistory('other')), /cannot merge/);
  });
});

test(`the run list keeps the last ${MAX_RUNS} runs and treats an older run as applied`, () => {
  let history = emptyHistory(KEY);
  for (let id = 1; id <= MAX_RUNS + 5; id++) history = applyRun(history, run(id, {})).history;
  assert.strictEqual(history.runs.length, MAX_RUNS);
  assert.strictEqual(history.runs[0], 6);
  assert.ok(hasRun(history, 3));
  assert.ok(!hasRun(history, MAX_RUNS + 6));
});
