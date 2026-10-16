/** Tests for the volatile test: the history it builds and the interruption of its attempts. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syntheticReport } = require('../../drive');
const { interruptedAttempts } = require('../../scenarios/history');
const { VOLATILE, greenBaseline } = require('../../scenarios/volatile');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-volatile-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

const [file, ...titles] = VOLATILE.split(' › ');
const history = (chromium, firefox) => {
  const entries = [];
  if (chromium !== undefined) entries.push(['chromium', file, titles[0], [chromium]]);
  if (firefox !== undefined) entries.push(['firefox', file, titles[0], [firefox]]);
  return write(`history-${chromium}-${firefox}.json`, syntheticReport(entries));
};
const contextWith = (historyFile) => ({
  baseline: () => ({ history: { file: historyFile } }),
  cwd: dir,
  once: (key, build) => build(),
  copy: () => dir,
});

describe('greenBaseline', () => {
  test('returns the baseline when each project has its own entry', () => {
    const green = greenBaseline(contextWith(history(1000, 1100)));
    assert.ok(green.history.file.endsWith('history-1000-1100.json'));
  });

  test('refuses equal durations, which build stores once', () => {
    assert.throws(() => greenBaseline(contextWith(history(1000, 1000))), /separate entry/);
  });

  test('refuses a history in which one project has no entry', () => {
    assert.throws(() => greenBaseline(contextWith(history(1000, undefined))), /separate entry/);
  });
});

describe('interruptedAttempts', () => {
  const spec = (title, statuses) => ({
    title,
    tests: [{ results: statuses.map((status) => ({ status })) }],
  });
  // A file suite names its file relative to the test directory; its specs name theirs relative to
  // the working directory.
  const fileSuite = (file, specs) => ({ title: file, file, specs });
  const report = (suites) => write('playwright.json', { suites });

  test('counts the interrupted attempts of the volatile test', () => {
    const file = report([
      fileSuite('volatile.spec.js', [spec('volatile step', ['passed', 'interrupted'])]),
    ]);
    assert.strictEqual(interruptedAttempts(file), 1);
  });

  test('counts them in a describe block of the file too', () => {
    const nested = {
      title: 'group',
      file: 'volatile.spec.js',
      specs: [spec('volatile step', ['interrupted'])],
    };
    const file = report([
      { title: 'volatile.spec.js', file: 'volatile.spec.js', suites: [nested] },
    ]);
    assert.strictEqual(interruptedAttempts(file), 1);
  });

  test('ignores a test with the same title in another file', () => {
    const decoy = report([
      fileSuite('volatile.spec.js', [spec('volatile step', ['passed'])]),
      fileSuite('other.spec.js', [spec('volatile step', ['interrupted'])]),
    ]);
    assert.strictEqual(interruptedAttempts(decoy), 0);
  });

  test('ignores a file of the same name in another directory', () => {
    const nested = report([
      fileSuite('volatile.spec.js', [spec('volatile step', ['passed'])]),
      fileSuite('z-decoy/volatile.spec.js', [spec('volatile step', ['interrupted'])]),
    ]);
    assert.strictEqual(interruptedAttempts(nested), 0);
  });

  test('ignores another test of the same file', () => {
    const other = report([fileSuite('volatile.spec.js', [spec('other step', ['interrupted'])])]);
    assert.strictEqual(interruptedAttempts(other), 0);
  });

  test('is zero for a run that was not interrupted', () => {
    const quiet = report([fileSuite('volatile.spec.js', [spec('volatile step', ['passed'])])]);
    assert.strictEqual(interruptedAttempts(quiet), 0);
  });
});
