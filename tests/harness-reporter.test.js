/** Tests for the harness reporter, driven with objects shaped like Playwright's public API. */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Reporter = require('../harness/reporter.js');

const testDir = path.join(os.tmpdir(), 'consumer', 'tests');

function fakeTest({
  file,
  project,
  titles,
  repeatEachIndex,
  annotations = [],
  results,
  line = 7,
  outcome = results.length > 1 ? 'flaky' : 'expected',
}) {
  return {
    location: { file: path.join(testDir, file), line, column: 3 },
    repeatEachIndex,
    annotations,
    results,
    parent: { project: () => ({ name: project, testDir }) },
    titlePath: () => ['', project, file, ...titles],
    outcome: () => outcome,
  };
}

const plain = fakeTest({
  file: 'catalog.spec.js',
  project: 'chromium',
  titles: ['catalog', 'loads the page'],
  repeatEachIndex: 1,
  results: [{ duration: 120 }],
});

const serialMember = fakeTest({
  file: 'serial-retry.spec.js',
  project: 'firefox',
  titles: ['two depends on the state from one'],
  repeatEachIndex: 0,
  annotations: [
    {
      type: 'serial',
      location: { file: path.join(testDir, 'serial-retry.spec.js'), line: 0, column: 0 },
    },
  ],
  results: [{ duration: 100 }, { duration: 40 }],
});

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PSP_HARNESS_RESULT;
});

function runReporter(tests, result, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-reporter-test-'));
  tempDirs.push(dir);
  const target = path.join(dir, 'out.json');
  process.env.PSP_HARNESS_RESULT = target;
  const reporter = new Reporter();
  reporter.onBegin(config, { allTests: () => tests });
  reporter.onEnd(result);
  return { target, read: () => JSON.parse(fs.readFileSync(target, 'utf8')) };
}

describe('HarnessReporter', () => {
  test('writes leaves with the same keys the list parser builds', () => {
    const { read } = runReporter([plain, serialMember], { duration: 321.5 });
    const written = read();
    assert.strictEqual(written.durationMs, 321.5);
    assert.deepStrictEqual(
      written.leaves.map((leaf) => leaf.key),
      [
        'chromium|catalog.spec.js|catalog › loads the page|#1',
        'firefox|serial-retry.spec.js|two depends on the state from one|#0',
      ]
    );
  });

  test('records outcome, attempts, duration, serial group and location', () => {
    const { read } = runReporter([plain, serialMember], { duration: 1 });
    const [first, second] = read().leaves;
    assert.deepStrictEqual(
      { outcome: first.outcome, attempts: first.attempts, durationMs: first.durationMs },
      { outcome: 'expected', attempts: 1, durationMs: 120 }
    );
    assert.deepStrictEqual(
      { outcome: second.outcome, attempts: second.attempts, durationMs: second.durationMs },
      { outcome: 'flaky', attempts: 2, durationMs: 140 }
    );
    assert.strictEqual(first.serialGroup, null);
    assert.strictEqual(second.serialGroup, 'firefox|serial-retry.spec.js|0:0|#0');
    assert.deepStrictEqual([first.line, first.column], [7, 3]);
  });

  test('records a test that skipped at runtime or never ran as skipped, so checks can reject it', () => {
    const skipped = fakeTest({
      file: 'cart.spec.js',
      project: 'chromium',
      titles: ['cart', 'adds an item'],
      repeatEachIndex: 0,
      results: [{ duration: 0 }],
      outcome: 'skipped',
    });
    const neverRan = fakeTest({
      file: 'cart.spec.js',
      project: 'firefox',
      titles: ['cart', 'adds an item'],
      repeatEachIndex: 0,
      results: [],
      outcome: 'skipped',
    });
    const { read } = runReporter([skipped, neverRan], { duration: 1 });
    assert.deepStrictEqual(
      read().leaves.map((leaf) => [leaf.key, leaf.outcome, leaf.attempts]),
      [
        ['chromium|cart.spec.js|cart › adds an item|#0', 'skipped', 1],
        ['firefox|cart.spec.js|cart › adds an item|#0', 'skipped', 0],
      ]
    );
  });

  test('records the config projects with their dependencies and teardown', () => {
    const config = {
      projects: [
        { name: 'setup', dependencies: [], teardown: 'teardown', testDir },
        { name: 'teardown', dependencies: [], testDir },
        { name: 'chromium', dependencies: ['setup'], testDir },
      ],
    };
    const { read } = runReporter([plain], { duration: 1 }, config);
    assert.deepStrictEqual(read().projects, [
      { name: 'setup', dependencies: [], teardown: 'teardown' },
      { name: 'teardown', dependencies: [], teardown: null },
      { name: 'chromium', dependencies: ['setup'], teardown: null },
    ]);
  });

  test('records no projects when the config has none', () => {
    assert.deepStrictEqual(runReporter([plain], { duration: 1 }).read().projects, []);
  });

  test('falls back to elapsed time when the result has no duration', () => {
    const { read } = runReporter([plain], {});
    assert.strictEqual(typeof read().durationMs, 'number');
  });

  test('writes nothing without a target path', () => {
    const reporter = new Reporter();
    reporter.onBegin({}, { allTests: () => [plain] });
    assert.doesNotThrow(() => reporter.onEnd({ duration: 1 }));
  });

  test('does not print to stdio', () => {
    assert.strictEqual(new Reporter().printsToStdio(), false);
  });
});
