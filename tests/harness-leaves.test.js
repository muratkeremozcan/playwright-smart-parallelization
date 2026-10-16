/** Tests for leaf keys, serial groups, the dependency map and the classification rule. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const leaves = require('../harness/leaves.js');
const { listFixture } = require('./support/fixture.js');

// The leaves of the real fixture, listed with --repeat-each=2 by the harness reporter.
const listed = () => listFixture({ repeatEach: 2 }).leaves;

function find(project, file, title, repeatIndex) {
  return listed().find(
    (leaf) =>
      leaf.project === project &&
      leaf.file === file &&
      leaf.titlePath.at(-1) === title &&
      leaf.repeatIndex === repeatIndex
  );
}

describe('leaves listed by the reporter from the real fixture', () => {
  test('yields one leaf per project and repeat with unique keys', () => {
    const all = listed();
    assert.strictEqual(new Set(all.map((leaf) => leaf.key)).size, all.length);
    const primary = all.filter((leaf) => !leaf.dependency);
    assert.strictEqual(primary.length, 2 * 52);
    assert.strictEqual(all.length - primary.length, 2);
  });

  test('builds the key as project, file, title path and repeat', () => {
    const leaf = find('chromium', 'catalog.spec.js', 'filters products by category', 1);
    assert.strictEqual(
      leaf.key,
      'chromium|catalog.spec.js|catalog › filters products by category|#1'
    );
    assert.deepStrictEqual(leaf.titlePath, ['catalog', 'filters products by category']);
    assert.strictEqual(leaf.file, 'catalog.spec.js');
  });

  test('numbers repeats from Playwright, adjacent and distinct per test', () => {
    const repeats = listed()
      .filter((leaf) => leaf.project === 'firefox' && leaf.file === 'flaky.spec.js')
      .map((leaf) => leaf.repeatIndex);
    assert.deepStrictEqual(repeats, [0, 1]);
  });

  test('keeps dependency projects at repeat zero', () => {
    const dependencyLeaves = listed().filter((leaf) => leaf.dependency);
    assert.deepStrictEqual(
      dependencyLeaves.map((leaf) => leaf.key),
      [
        'setup|global.setup.js|prepare the environment|#0',
        'teardown|global.teardown.js|clean up the environment|#0',
      ]
    );
  });

  test('assigns a serial group to members of a serial suite, per project and repeat', () => {
    const one = find('chromium', 'serial-flow.spec.js', 'one signs in', 0);
    const two = find('chromium', 'serial-flow.spec.js', 'two uses the session from one', 0);
    const otherRepeat = find('chromium', 'serial-flow.spec.js', 'one signs in', 1);
    const otherProject = find('firefox', 'serial-flow.spec.js', 'one signs in', 0);
    assert.ok(one.serialGroup);
    assert.strictEqual(two.serialGroup, one.serialGroup);
    assert.notStrictEqual(otherRepeat.serialGroup, one.serialGroup);
    assert.notStrictEqual(otherProject.serialGroup, one.serialGroup);
  });

  test('leaves tests outside a serial suite without a group', () => {
    assert.strictEqual(
      find('chromium', 'flaky.spec.js', 'recovers after a retry', 0).serialGroup,
      null
    );
    assert.strictEqual(find('chromium', 'catalog.spec.js', 'loads the page', 0).serialGroup, null);
  });

  test('records the spec line and column for the test-list form', () => {
    const leaf = find('chromium', 'catalog.spec.js', 'loads the page', 0);
    assert.strictEqual(
      leaves.listLine(leaf),
      '[chromium] › catalog.spec.js:7:3 › catalog › loads the page'
    );
  });
});

describe('serialGroupId', () => {
  test('picks the outermost serial annotation of nested serial suites', () => {
    const group = leaves.serialGroupId({
      project: 'p',
      repeatIndex: 0,
      testDir: '/t',
      annotations: [
        { type: 'serial', location: { file: '/t/a.js', line: 9, column: 3 } },
        { type: 'serial', location: { file: '/t/a.js', line: 4, column: 1 } },
      ],
    });
    assert.strictEqual(group, 'p|a.js|4:1|#0');
  });
});

describe('dependencyMap', () => {
  const project = (name, dependencies = [], teardown = null) => ({ name, dependencies, teardown });

  test('lists dependencies and teardowns, transitively', () => {
    const map = leaves.dependencyMap([
      project('setup', [], 'teardown'),
      project('teardown'),
      project('chromium', ['setup']),
      project('deep', ['chromium']),
    ]);
    assert.deepStrictEqual(map, {
      setup: ['teardown'],
      teardown: [],
      chromium: ['setup', 'teardown'],
      deep: ['chromium', 'setup', 'teardown'],
    });
  });

  test('survives a cycle and an unknown dependency', () => {
    const map = leaves.dependencyMap([project('a', ['b']), project('b', ['a', 'ghost'])]);
    assert.deepStrictEqual(map.a.sort(), ['a', 'b', 'ghost']);
  });

  test('names the projects some other project needs', () => {
    assert.deepStrictEqual(
      [...leaves.dependencyProjects({ a: ['b'], b: [], c: ['b', 'a'] })].sort(),
      ['a', 'b']
    );
  });
});

describe('classify, the one classification rule', () => {
  const roles = (present, topLevel) =>
    leaves
      .classify(
        present.map((project) => ({ project })),
        new Set(topLevel)
      )
      .map((leaf) => [leaf.project, leaf.dependency ? 'dependency' : 'primary']);

  test('a project is a dependency unless Playwright treats it as top-level', () => {
    assert.deepStrictEqual(roles(['setup', 'chromium', 'teardown'], ['chromium']), [
      ['setup', 'dependency'],
      ['chromium', 'primary'],
      ['teardown', 'dependency'],
    ]);
    assert.deepStrictEqual(roles(['setup', 'teardown'], ['setup']), [
      ['setup', 'primary'],
      ['teardown', 'dependency'],
    ]);
  });

  test('a project the filters left standing alone is primary', () => {
    assert.deepStrictEqual(roles(['teardown'], ['teardown']), [['teardown', 'primary']]);
  });

  test('when every listed project is top-level nothing is a dependency', () => {
    assert.deepStrictEqual(roles(['setup', 'teardown'], ['setup', 'teardown']), [
      ['setup', 'primary'],
      ['teardown', 'primary'],
    ]);
  });
});

describe('key helpers', () => {
  test('testId and groupBase strip the repeat suffix', () => {
    assert.strictEqual(leaves.testId({ key: 'p|f|a › b|#3' }), 'p|f|a › b');
    assert.strictEqual(leaves.groupBase('p|f|0:0|#12'), 'p|f|0:0');
  });
});
