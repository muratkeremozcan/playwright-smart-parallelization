/** Tests for leaf parsing, dependency derivation and key construction. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const sample = require('./samples/list-repeat-each-2.json');
const leaves = require('../harness/leaves.js');

const parsed = leaves.parseList(sample);

function find(project, file, title, repeatIndex) {
  return parsed.find(
    (leaf) =>
      leaf.project === project &&
      leaf.file === file &&
      leaf.titlePath.at(-1) === title &&
      leaf.repeatIndex === repeatIndex
  );
}

describe('parseList against a recorded list JSON', () => {
  test('yields one leaf per project and repeat', () => {
    // setup, teardown, and 3 catalog + 1 flaky + 2 serial-flow tests in two projects, repeated 2x
    // for the spec files, once for the dependency projects (repeat-each skips them).
    assert.strictEqual(parsed.length, 2 + 2 * 2 * (3 + 1 + 2));
    assert.strictEqual(new Set(parsed.map((leaf) => leaf.key)).size, parsed.length);
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

  test('derives the repeat index from occurrence order within a project', () => {
    const repeats = parsed
      .filter((leaf) => leaf.project === 'firefox' && leaf.file === 'flaky.spec.js')
      .map((leaf) => leaf.repeatIndex);
    assert.deepStrictEqual(repeats, [0, 1]);
  });

  test('keeps dependency projects at repeat zero', () => {
    const dependencyLeaves = parsed.filter((leaf) => ['setup', 'teardown'].includes(leaf.project));
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
    assert.strictEqual(one.serialGroup, 'chromium|serial-flow.spec.js|0:0|#0');
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

  test('also parses repeats delivered as adjacent tests of one spec', () => {
    const adjacent = {
      config: { projects: [{ name: 'p', testDir: '/t' }] },
      suites: [
        {
          title: 'a.spec.js',
          file: 'a.spec.js',
          specs: [
            {
              title: 'x',
              file: 'a.spec.js',
              line: 3,
              column: 1,
              tests: [
                { projectName: 'p', annotations: [] },
                { projectName: 'p', annotations: [] },
              ],
            },
          ],
        },
      ],
    };
    assert.deepStrictEqual(
      leaves.parseList(adjacent).map((leaf) => leaf.key),
      ['p|a.spec.js|x|#0', 'p|a.spec.js|x|#1']
    );
  });

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

describe('dependency derivation', () => {
  const lists = {
    setup: [{ project: 'setup' }, { project: 'teardown' }],
    teardown: [{ project: 'teardown' }],
    chromium: [{ project: 'setup' }, { project: 'teardown' }, { project: 'chromium' }],
    firefox: [{ project: 'firefox' }, { project: 'setup' }, { project: 'teardown' }],
  };

  test('lists the projects of a project listing minus the project itself', () => {
    assert.deepStrictEqual(leaves.deriveDependencies(lists), {
      setup: ['teardown'],
      teardown: [],
      chromium: ['setup', 'teardown'],
      firefox: ['setup', 'teardown'],
    });
  });

  test('marks leaves of dependency projects', () => {
    const dependencies = leaves.deriveDependencies(lists);
    const marked = leaves.applyDependencies(
      [{ project: 'setup' }, { project: 'chromium' }, { project: 'teardown' }],
      dependencies
    );
    assert.deepStrictEqual(
      marked.map((leaf) => leaf.dependency),
      [true, false, true]
    );
  });

  test('derives dependencies from the recorded sample projects', () => {
    assert.deepStrictEqual(leaves.projectNames(sample), [
      'setup',
      'teardown',
      'chromium',
      'firefox',
    ]);
  });
});

describe('key helpers', () => {
  test('testId and groupBase strip the repeat suffix', () => {
    assert.strictEqual(leaves.testId({ key: 'p|f|a › b|#3' }), 'p|f|a › b');
    assert.strictEqual(leaves.groupBase('p|f|0:0|#12'), 'p|f|0:0');
  });
});
