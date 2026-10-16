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

  test('keys a leaf by the Playwright test id and labels it project, file, title path and repeat', () => {
    const leaf = find('chromium', 'catalog.spec.js', 'filters products by category', 1);
    assert.match(leaf.key, /^[0-9a-f]{20}-[0-9a-f]{20}$/);
    assert.strictEqual(
      leaf.label,
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
      dependencyLeaves.map((leaf) => leaf.label),
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

describe('serialGroupId and leafLabel', () => {
  test('build the group id from the project, spec file, suite titles and repeat', () => {
    assert.strictEqual(
      leaves.serialGroupId({
        project: 'chromium',
        specFile: 'a.spec.js',
        suiteTitles: ['outer', 'inner'],
        repeatIndex: 1,
      }),
      'chromium|a.spec.js|outer › inner|#1'
    );
  });

  test('label a leaf for people', () => {
    assert.strictEqual(
      leaves.leafLabel({ project: 'p', specFile: 'a.js', titlePath: ['x', 'y'], repeatIndex: 0 }),
      'p|a.js|x › y|#0'
    );
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
    assert.deepStrictEqual(
      { ...map },
      {
        setup: ['teardown'],
        teardown: [],
        chromium: ['setup', 'teardown'],
        deep: ['chromium', 'setup', 'teardown'],
      }
    );
  });

  test('keeps a project named like an Object.prototype accessor', () => {
    const map = leaves.dependencyMap([project('setup'), project('__proto__', ['setup'])]);
    assert.deepStrictEqual(Object.keys(map), ['setup', '__proto__']);
    assert.deepStrictEqual(map['__proto__'], ['setup']);
    assert.strictEqual(Object.getPrototypeOf(map), null);
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

describe('assertNamedProjects', () => {
  const named = (name) => ({ name, dependencies: [] });

  test('accepts unique non-empty names, including one like an Object.prototype accessor', () => {
    assert.doesNotThrow(() => leaves.assertNamedProjects([named('a'), named('__proto__')]));
  });

  test('rejects an unnamed project, naming its position', () => {
    assert.throws(
      () => leaves.assertNamedProjects([named('a'), named('')]),
      /project #2 has no name.*unique non-empty name/
    );
  });

  test('rejects a repeated name', () => {
    assert.throws(
      () => leaves.assertNamedProjects([named('a'), named('a')]),
      /project name "a" is used twice/
    );
  });
});

describe('key helpers', () => {
  test('groupBase strips the repeat suffix', () => {
    assert.strictEqual(leaves.groupBase('1|f|a › b|#12'), '1|f|a › b');
  });

  test('buildLeaf keys by the id and keeps the call location apart from the spec file', () => {
    const leaf = leaves.buildLeaf({
      id: 'abc',
      project: 'p',
      specFile: 'a.spec.js',
      file: 'factory.js',
      titlePath: ['t'],
      repeatIndex: 2,
      serialGroup: null,
      line: 7,
      column: 3,
    });
    assert.strictEqual(leaf.key, 'abc');
    assert.strictEqual(leaf.testRef, 'p|a.spec.js|t');
    assert.strictEqual(leaf.label, 'p|a.spec.js|t|#2');
    assert.strictEqual(leaves.listLine(leaf), '[p] › factory.js:7:3 › t');
    assert.match(leaves.loadLine(leaf), /^\[p\] › a\.spec\.js:1:1 › .+$/);
  });
});
