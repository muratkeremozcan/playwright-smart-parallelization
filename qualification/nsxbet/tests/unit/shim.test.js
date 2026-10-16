/** Tests for the shim that gives the engine projects and serial groups. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const shim = require('../../shim');
const { engineIds } = require('../../playwright');

const ROOT = '/consumer/tests';

function spec(project, file, title, line) {
  return { title, file, line, column: 1, tests: [{ projectName: project, results: [] }] };
}

const both = (file, title, line) => [
  spec('chromium', file, title, line),
  spec('firefox', file, title, line),
];

const config = {
  rootDir: ROOT,
  projects: [
    { name: 'chromium', testDir: ROOT },
    { name: 'firefox', testDir: ROOT },
  ],
};

const list = {
  config,
  suites: [
    {
      title: 'flow.spec.js',
      file: 'flow.spec.js',
      specs: [
        ...both('flow.spec.js', 'one', 5),
        ...both('flow.spec.js', 'two', 9),
        ...both('flow.spec.js', 'three', 13),
      ],
    },
    { title: 'plain.spec.js', file: 'plain.spec.js', specs: both('plain.spec.js', 'alone', 4) },
  ],
};

/** A harness leaf: `file` is relative to the config directory. */
function leaf(project, file, title, line, { serial = false, repeat = 0 } = {}) {
  return {
    key: `${project}-${file}-${title}-${repeat}`,
    project,
    file,
    specFile: file,
    titlePath: [title],
    repeatIndex: repeat,
    serialGroup: serial ? `${project}|${file}|flow|#${repeat}` : null,
    dependency: false,
    line,
    column: 1,
  };
}

const flow = (project, repeat = 0) => [
  leaf(project, 'flow.spec.js', 'one', 5, { serial: true, repeat }),
  leaf(project, 'flow.spec.js', 'two', 9, { serial: true, repeat }),
  leaf(project, 'flow.spec.js', 'three', 13, { serial: true, repeat }),
];
const leaves = [
  ...flow('chromium'),
  leaf('chromium', 'plain.spec.js', 'alone', 4),
  ...flow('firefox'),
  leaf('firefox', 'plain.spec.js', 'alone', 4),
];

const entry = (file, duration) => ({ file, duration, runs: 2, lastRun: 'x' });
const history = (project) => ({
  version: 2,
  updatedAt: '2026-01-01T00:00:00.000Z',
  tests: {
    'flow.spec.js::one': entry('flow.spec.js', project === 'chromium' ? 100 : 1000),
    'flow.spec.js::two': entry('flow.spec.js', 250),
    'plain.spec.js::alone': entry('plain.spec.js', 40),
  },
});

const none = { chromium: null, firefox: null };
const titlesOf = (prepared) => engineIds(prepared.list).map((id) => id.replace('::', ' '));

describe('serialGroups', () => {
  test('finds one group of three per project', () => {
    const groups = shim.serialGroups(leaves);
    assert.deepStrictEqual(
      groups.map((group) => [group.representative.project, group.members.length]),
      [
        ['chromium', 3],
        ['firefox', 3],
      ]
    );
    assert.ok(groups.every((group) => group.representative.titlePath[0] === 'one'));
  });

  test('a serial group of one test is not a group', () => {
    assert.deepStrictEqual(shim.serialGroups([flow('chromium')[0]]), []);
  });
});

describe('prepare', () => {
  test('keeps one stand-in per group and every other test, per project', () => {
    assert.deepStrictEqual(titlesOf(shim.prepare(list, none, leaves)), [
      'chromium/flow.spec.js one',
      'firefox/flow.spec.js one',
      'chromium/plain.spec.js alone',
      'firefox/plain.spec.js alone',
    ]);
  });

  test('prefixes every file with its project so one test in two projects is two tests', () => {
    const files = shim
      .prepare(list, none, leaves)
      .list.suites.flatMap((s) => s.specs.map((x) => x.file));
    assert.deepStrictEqual(files, [
      'chromium/flow.spec.js',
      'firefox/flow.spec.js',
      'chromium/plain.spec.js',
      'firefox/plain.spec.js',
    ]);
  });

  test('weights each stand-in by its own project group and uses the default for unknowns', () => {
    const { timing } = shim.prepare(
      list,
      { chromium: history('chromium'), firefox: history('firefox') },
      leaves
    );
    assert.strictEqual(timing.tests['chromium/flow.spec.js::one'].duration, 100 + 250 + 30000);
    assert.strictEqual(timing.tests['firefox/flow.spec.js::one'].duration, 1000 + 250 + 30000);
    assert.strictEqual(timing.tests['firefox/plain.spec.js::alone'].duration, 40);
    assert.strictEqual(timing.tests['firefox/plain.spec.js::alone'].file, 'firefox/plain.spec.js');
  });

  test('does not change its inputs', () => {
    const input = history('chromium');
    shim.prepare(list, { chromium: input, firefox: null }, leaves);
    assert.strictEqual(input.tests['flow.spec.js::one'].duration, 100);
    assert.strictEqual(list.suites[0].specs.length, 6);
  });

  test('lists a test once however many repeats the list has', () => {
    const repeated = {
      ...list,
      suites: list.suites.map((suite) => ({ ...suite, specs: [...suite.specs, ...suite.specs] })),
    };
    const twice = [...leaves, ...flow('chromium', 1), ...flow('firefox', 1)];
    assert.deepStrictEqual(
      titlesOf(shim.prepare(repeated, none, twice)),
      titlesOf(shim.prepare(list, none, leaves))
    );
  });

  test('has no timing when no project has history', () => {
    assert.strictEqual(shim.prepare(list, none, leaves).timing, null);
  });
});

describe('finish', () => {
  const prepared = shim.prepare(list, none, leaves);
  const assignment = (lines) => ({ shards: {}, testListFiles: lines });

  test('replaces a stand-in with every member and selects each in its own project', () => {
    const result = shim.finish(
      assignment({
        1: 'chromium/flow.spec.js › one\n',
        2: 'firefox/plain.spec.js › alone\n',
        3: '',
      }),
      prepared
    );
    assert.strictEqual(
      result.testListFiles[1],
      '[chromium] › flow.spec.js › one\n[chromium] › flow.spec.js › two\n[chromium] › flow.spec.js › three\n'
    );
    assert.strictEqual(result.testListFiles[2], '[firefox] › plain.spec.js › alone\n');
    assert.strictEqual(result.testListFiles[3], '');
  });

  test('lists a repeated group member once', () => {
    const twice = [...leaves, ...flow('chromium', 1)];
    const result = shim.finish(
      assignment({ 1: 'chromium/flow.spec.js › one\n' }),
      shim.prepare(list, none, twice)
    );
    assert.strictEqual(result.testListFiles[1].split('\n').filter(Boolean).length, 3);
  });

  test('rejects a line that matches no listed test', () => {
    assert.throws(
      () => shim.finish(assignment({ 1: 'chromium/other.spec.js › x\n' }), prepared),
      /unknown line/
    );
  });
});

describe('test directory', () => {
  // The config directory is /consumer, the tests are in /consumer/tests. A leaf's file includes
  // the directory, the list JSON and the engine do not.
  const nested = { ...list, config: { ...config, rootDir: '/consumer' } };
  const inTests = leaves.map((l) => ({ ...l, file: `tests/${l.file}` }));

  test('derives the prefix from the config and strips it from the engine side', () => {
    const prepared = shim.prepare(nested, none, inTests);
    assert.strictEqual(prepared.prefix, 'tests');
    assert.deepStrictEqual(titlesOf(prepared), titlesOf(shim.prepare(list, none, leaves)));
  });

  test('puts the directory back in the Playwright line', () => {
    const prepared = shim.prepare(nested, none, inTests);
    const result = shim.finish(
      { shards: {}, testListFiles: { 1: 'tests/chromium/plain.spec.js › alone\n' } },
      prepared
    );
    assert.strictEqual(result.testListFiles[1], '[chromium] › tests/plain.spec.js › alone\n');
  });

  test('refuses projects that do not share one test directory', () => {
    const split = {
      ...list,
      config: {
        ...config,
        projects: [
          { name: 'chromium', testDir: ROOT },
          { name: 'firefox', testDir: '/consumer/other' },
        ],
      },
    };
    assert.throws(() => shim.prepare(split, none, leaves), /share one testDir/);
  });

  test('hands the engine only the projects that carry tests', () => {
    const withSetup = {
      ...list,
      config: {
        ...config,
        projects: [{ name: 'setup', testDir: '/elsewhere' }, ...config.projects],
      },
    };
    const prepared = shim.prepare(withSetup, none, leaves);
    assert.deepStrictEqual(
      prepared.list.config.projects.map((p) => p.name),
      ['chromium', 'firefox']
    );
  });
});

describe('names', () => {
  test('ids, lines and Playwright lines follow the conventions', () => {
    const [first] = leaves;
    assert.strictEqual(shim.idOf(first), 'chromium/flow.spec.js::one');
    assert.strictEqual(shim.lineOf(first), 'chromium/flow.spec.js › one');
    assert.strictEqual(shim.playwrightLine(first), '[chromium] › flow.spec.js › one');
  });
});

describe('engineIds', () => {
  test('joins the file, the describe titles and the test title, leaving the file suite out', () => {
    const json = {
      suites: [
        {
          title: 'a.spec.js',
          file: 'a.spec.js',
          specs: [{ title: 'top', file: 'a.spec.js' }],
          suites: [{ title: 'group', specs: [{ title: 'inner', file: 'a.spec.js' }] }],
        },
      ],
    };
    assert.deepStrictEqual(engineIds(json), ['a.spec.js::top', 'a.spec.js::group::inner']);
  });
});
