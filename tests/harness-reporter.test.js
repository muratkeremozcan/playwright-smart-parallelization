/** Tests for the harness reporter, driven with objects shaped like Playwright's public API. */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Reporter = require('../harness/reporter.js');

const testDir = path.join(os.tmpdir(), 'consumer', 'tests');
const fileOf = (file) => path.join(testDir, file);

const chromium = { name: 'chromium', testDir, dependencies: [], teardown: undefined };
const firefox = { name: 'firefox', testDir, dependencies: [], teardown: undefined };
const config = { projects: [chromium, firefox] };

/**
 * A describe or file suite. `titles` are the describe titles down to this suite, `location` where
 * the suite was declared (a file suite sits at line 0).
 */
function fakeSuite({ project, file, titles = [], location, parent = null }) {
  return {
    parent,
    project: () => project,
    location: location || { file: fileOf(file), line: 0, column: 0 },
    titlePath: () => ['', project.name, file, ...titles],
  };
}

/**
 * A test. `describes` lists the enclosing describe suites outermost first, each
 * `{ title, line, serial }`; a serial one adds a serial annotation at its own location, outermost
 * annotation first, as Playwright does. `where` is the file the test call sits in, which differs
 * from `file` for tests a helper registers.
 */
const suites = new WeakMap();

function fakeTest({
  id,
  file,
  where = file,
  project = chromium,
  title,
  describes = [],
  repeatEachIndex = 0,
  results = [{ duration: 10 }],
  outcome = results.length > 1 ? 'flaky' : 'expected',
  line = 7,
}) {
  let parent = fakeSuite({ project, file });
  const annotations = [];
  const titles = [];
  for (const describeSuite of describes) {
    titles.push(describeSuite.title);
    const location = {
      file: fileOf(describeSuite.file || file),
      line: describeSuite.line,
      column: 3,
    };
    // Playwright shares one suite object among the tests of a describe.
    if (!suites.has(describeSuite)) {
      suites.set(
        describeSuite,
        fakeSuite({ project, file, titles: [...titles], location, parent })
      );
    }
    parent = suites.get(describeSuite);
    if (describeSuite.serial) annotations.push({ type: 'serial', location });
  }
  return {
    id,
    location: { file: fileOf(where), line, column: 3 },
    repeatEachIndex,
    annotations,
    results,
    parent,
    titlePath: () => ['', project.name, file, ...titles, title],
    outcome: () => outcome,
  };
}

const plain = fakeTest({
  id: 'id-plain',
  file: 'catalog.spec.js',
  describes: [{ title: 'catalog', line: 5 }],
  title: 'loads the page',
  repeatEachIndex: 1,
  results: [{ duration: 120 }],
});

const serialMember = fakeTest({
  id: 'id-serial',
  file: 'serial-retry.spec.js',
  project: firefox,
  title: 'two depends on the state from one',
  describes: [{ title: 'retry', line: 4, serial: true }],
  results: [{ duration: 100 }, { duration: 40 }],
});

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PSP_HARNESS_RESULT;
});

function runReporter(tests, result, given = config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-reporter-test-'));
  tempDirs.push(dir);
  const target = path.join(dir, 'out.json');
  process.env.PSP_HARNESS_RESULT = target;
  const reporter = new Reporter();
  reporter.onBegin(given, { allTests: () => tests });
  reporter.onEnd(result);
  return { target, read: () => JSON.parse(fs.readFileSync(target, 'utf8')) };
}

describe('HarnessReporter', () => {
  test("keys each leaf by Playwright's test id and names it for people with a label", () => {
    const { read } = runReporter([plain, serialMember], { duration: 321.5 });
    const written = read();
    assert.strictEqual(written.durationMs, 321.5);
    assert.deepStrictEqual(
      written.leaves.map((leaf) => [leaf.key, leaf.label]),
      [
        ['id-plain', 'chromium|catalog.spec.js|catalog › loads the page|#1'],
        ['id-serial', 'firefox|serial-retry.spec.js|retry › two depends on the state from one|#0'],
      ]
    );
  });

  test("tells a helper's tests apart by their spec file, not by where the call sits", () => {
    const a = fakeTest({ id: 'a', file: 'a.spec.js', where: 'factory.js', title: 'shared' });
    const b = fakeTest({ id: 'b', file: 'b.spec.js', where: 'factory.js', title: 'shared' });
    const [first, second] = runReporter([a, b], { duration: 1 }).read().leaves;
    assert.deepStrictEqual([first.file, second.file], ['factory.js', 'factory.js']);
    assert.deepStrictEqual([first.specFile, second.specFile], ['a.spec.js', 'b.spec.js']);
    assert.notStrictEqual(first.label, second.label);
    assert.notStrictEqual(first.testRef, second.testRef);
  });

  test('tells projects that share a name apart by their index in the config', () => {
    const unnamedA = { name: '', testDir, dependencies: [] };
    const unnamedB = { name: '', testDir, dependencies: [] };
    const a = fakeTest({ id: 'a', file: 's.spec.js', project: unnamedA, title: 't' });
    const b = fakeTest({ id: 'b', file: 's.spec.js', project: unnamedB, title: 't' });
    const [first, second] = runReporter(
      [a, b],
      { duration: 1 },
      {
        projects: [unnamedA, unnamedB],
      }
    ).read().leaves;
    assert.strictEqual(first.label, second.label);
    assert.notStrictEqual(first.testRef, second.testRef);
    assert.notStrictEqual(first.key, second.key);
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
    assert.strictEqual(second.serialGroup, '1|serial-retry.spec.js|retry|#0');
    assert.deepStrictEqual([first.line, first.column], [7, 3]);
  });

  describe('serial groups', () => {
    const member = (id, describes, title = id) =>
      fakeTest({ id, file: 'groups.spec.js', title, describes });
    const group = (tests, which = 0) =>
      runReporter(tests, { duration: 1 }).read().leaves[which].serialGroup;

    test('are the outermost serial suite, whatever its line number', () => {
      // The inner suite sits above the outer one, as when a helper declares it.
      const inner = { title: 'inner', line: 3, serial: true };
      const outer = { title: 'outer', line: 20, serial: true };
      const leaves = runReporter([member('x', [outer]), member('y', [outer, inner])], {
        duration: 1,
      }).read().leaves;
      assert.deepStrictEqual(
        leaves.map((leaf) => leaf.serialGroup),
        ['0|groups.spec.js|outer|#0', '0|groups.spec.js|outer|#0']
      );
    });

    test('tell sibling suites built at one call site apart by their titles', () => {
      const left = { title: 'left', line: 15, serial: true };
      const right = { title: 'right', line: 15, serial: true };
      const leaves = runReporter([member('a', [left]), member('b', [left]), member('c', [right])], {
        duration: 1,
      }).read().leaves;
      const [a, b, c] = leaves.map((leaf) => leaf.serialGroup);
      assert.strictEqual(a, b);
      assert.notStrictEqual(a, c);
    });

    test('leave a test outside serial suites without a group', () => {
      assert.strictEqual(group([member('p', [{ title: 'plain', line: 4 }])]), null);
    });

    test('fail closed when two distinct suites share one id', () => {
      // Two sibling suites with the same title built at one call site cannot be told apart.
      const one = { title: 'same', line: 15, serial: true };
      const two = { title: 'same', line: 15, serial: true };
      assert.throws(
        () => runReporter([member('a', [one]), member('b', [two])], { duration: 1 }),
        /share the group/
      );
    });

    test('fail closed when a serial and a plain suite share one location', () => {
      // A recursive helper made both at line 5, and only one of them is serial.
      const serial = { title: 'a', line: 5, serial: true };
      const plainSuite = { title: 'b', line: 5 };
      assert.throws(
        () => runReporter([member('x', [serial, plainSuite])], { duration: 1 }),
        /1 serial annotations and 2 suites/
      );
    });

    test('take the outermost of nested serial suites that share one location', () => {
      const outer = { title: 'a', line: 5, serial: true };
      const inner = { title: 'b', line: 5, serial: true };
      assert.strictEqual(group([member('x', [outer, inner])]), '0|groups.spec.js|a|#0');
    });

    test('fail closed when the serial ancestors cannot be matched exactly', () => {
      const broken = fakeTest({ id: 'x', file: 'g.spec.js', title: 'x', describes: [] });
      broken.annotations.push({
        type: 'serial',
        location: { file: fileOf('g.spec.js'), line: 9, column: 3 },
      });
      assert.throws(() => runReporter([broken], { duration: 1 }), /cannot tell which suite/);
    });
  });

  test('fails closed when two tests share an id', () => {
    const a = fakeTest({ id: 'same', file: 'a.spec.js', title: 'one' });
    const b = fakeTest({ id: 'same', file: 'b.spec.js', title: 'two' });
    assert.throws(() => runReporter([a, b], { duration: 1 }), /share the id same/);
  });

  test('records a test that skipped at runtime or never ran as skipped, so checks can reject it', () => {
    const skipped = fakeTest({
      id: 's1',
      file: 'cart.spec.js',
      describes: [{ title: 'cart', line: 5 }],
      title: 'adds an item',
      results: [{ duration: 0 }],
      outcome: 'skipped',
    });
    const neverRan = fakeTest({
      id: 's2',
      file: 'cart.spec.js',
      project: firefox,
      describes: [{ title: 'cart', line: 5 }],
      title: 'adds an item',
      results: [],
      outcome: 'skipped',
    });
    const { read } = runReporter([skipped, neverRan], { duration: 1 });
    assert.deepStrictEqual(
      read().leaves.map((leaf) => [leaf.label, leaf.outcome, leaf.attempts]),
      [
        ['chromium|cart.spec.js|cart › adds an item|#0', 'skipped', 1],
        ['firefox|cart.spec.js|cart › adds an item|#0', 'skipped', 0],
      ]
    );
  });

  test('records the config projects with their dependencies and teardown', () => {
    const setup = { name: 'setup', dependencies: [], teardown: 'teardown', testDir };
    const teardown = { name: 'teardown', dependencies: [], testDir };
    const browser = { name: 'chromium', dependencies: ['setup'], testDir };
    const { read } = runReporter(
      [plain],
      { duration: 1 },
      { projects: [setup, teardown, browser] }
    );
    assert.deepStrictEqual(read().projects, [
      { name: 'setup', dependencies: [], teardown: 'teardown' },
      { name: 'teardown', dependencies: [], teardown: null },
      { name: 'chromium', dependencies: ['setup'], teardown: null },
    ]);
  });

  test('records the sharding of the config', () => {
    assert.strictEqual(runReporter([plain], { duration: 1 }, config).read().shard, null);
    const sharded = { ...config, shard: { current: 1, total: 2 } };
    assert.deepStrictEqual(runReporter([plain], { duration: 1 }, sharded).read().shard, {
      current: 1,
      total: 2,
    });
  });

  test('records no projects when the config has none', () => {
    assert.deepStrictEqual(runReporter([plain], { duration: 1 }, {}).read().projects, []);
  });

  test('falls back to elapsed time when the result has no duration', () => {
    const { read } = runReporter([plain], {});
    assert.strictEqual(typeof read().durationMs, 'number');
  });

  test('writes nothing without a target path', () => {
    const reporter = new Reporter();
    reporter.onBegin(config, { allTests: () => [plain] });
    assert.doesNotThrow(() => reporter.onEnd({ duration: 1 }));
  });

  test('does not print to stdio', () => {
    assert.strictEqual(new Reporter().printsToStdio(), false);
  });
});
