/** Tests for the shim that gives the engine projects and serial groups. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const shim = require('../../shim');
const { parseList } = require('../../../../harness/leaves');

const ROOT = '/consumer/tests';

function spec(project, file, title, line, { serial = false } = {}) {
  const annotations = serial
    ? [{ type: 'serial', location: { file: `${ROOT}/${file}`, line: 0, column: 0 } }]
    : [];
  return {
    title,
    file,
    line,
    column: 1,
    tests: [{ projectName: project, annotations, results: [] }],
  };
}

const both = (file, title, line, options) => [
  spec('chromium', file, title, line, options),
  spec('firefox', file, title, line, options),
];

const list = {
  config: {
    rootDir: ROOT,
    projects: [
      { name: 'chromium', testDir: ROOT },
      { name: 'firefox', testDir: ROOT },
    ],
  },
  suites: [
    {
      title: 'flow.spec.js',
      file: 'flow.spec.js',
      specs: [
        ...both('flow.spec.js', 'one', 5, { serial: true }),
        ...both('flow.spec.js', 'two', 9, { serial: true }),
        ...both('flow.spec.js', 'three', 13, { serial: true }),
      ],
    },
    { title: 'plain.spec.js', file: 'plain.spec.js', specs: both('plain.spec.js', 'alone', 4) },
  ],
};

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

const leaves = parseList(list);

describe('serialGroups', () => {
  test('finds one group of three per project', () => {
    const groups = shim.serialGroups(leaves);
    assert.strictEqual(groups.length, 2);
    for (const group of groups) {
      assert.deepStrictEqual(
        group.members.map((leaf) => leaf.titlePath[0]),
        ['one', 'two', 'three']
      );
      assert.strictEqual(group.representative.titlePath[0], 'one');
    }
    assert.deepStrictEqual(
      groups.map((group) => group.representative.project),
      ['chromium', 'firefox']
    );
  });

  test('a serial group of one test is not a group', () => {
    const single = { ...list, suites: [{ ...list.suites[0], specs: [list.suites[0].specs[0]] }] };
    assert.deepStrictEqual(shim.serialGroups(parseList(single)), []);
  });
});

describe('prepare', () => {
  const titlesOf = (prepared) =>
    parseList(prepared.list).map((leaf) => `${leaf.project}:${leaf.titlePath[0]}`);

  test('keeps one stand-in per group and every other test, per project', () => {
    const prepared = shim.prepare(list, { chromium: null, firefox: null });
    assert.deepStrictEqual(titlesOf(prepared), [
      'chromium:one',
      'firefox:one',
      'chromium:alone',
      'firefox:alone',
    ]);
  });

  test('prefixes every file with its project so one test in two projects is two tests', () => {
    const prepared = shim.prepare(list, { chromium: null, firefox: null });
    const files = parseList(prepared.list).map((leaf) => leaf.file);
    assert.deepStrictEqual(files, [
      'chromium/flow.spec.js',
      'firefox/flow.spec.js',
      'chromium/plain.spec.js',
      'firefox/plain.spec.js',
    ]);
  });

  test('weights each stand-in by its own project group and uses the default for unknowns', () => {
    const { timing } = shim.prepare(list, {
      chromium: history('chromium'),
      firefox: history('firefox'),
    });
    assert.strictEqual(timing.tests['chromium/flow.spec.js::one'].duration, 100 + 250 + 30000);
    assert.strictEqual(timing.tests['firefox/flow.spec.js::one'].duration, 1000 + 250 + 30000);
    assert.strictEqual(timing.tests['firefox/plain.spec.js::alone'].duration, 40);
    assert.strictEqual(timing.tests['firefox/plain.spec.js::alone'].file, 'firefox/plain.spec.js');
  });

  test('does not change its inputs', () => {
    const input = history('chromium');
    shim.prepare(list, { chromium: input, firefox: null });
    assert.strictEqual(input.tests['flow.spec.js::one'].duration, 100);
    assert.strictEqual(list.suites[0].specs.length, 6);
  });

  test('lists a test once however many repeats the list has', () => {
    const repeated = {
      ...list,
      suites: list.suites.map((suite) => ({ ...suite, specs: [...suite.specs, ...suite.specs] })),
    };
    const prepared = shim.prepare(repeated, { chromium: null, firefox: null });
    assert.deepStrictEqual(
      titlesOf(prepared),
      titlesOf(shim.prepare(list, { chromium: null, firefox: null }))
    );
  });

  test('has no timing when no project has history', () => {
    assert.strictEqual(shim.prepare(list, { chromium: null, firefox: null }).timing, null);
  });
});

describe('finish', () => {
  const { groups } = shim.prepare(list, { chromium: null, firefox: null });
  const assignment = (lines) => ({ shards: {}, testListFiles: lines });

  test('replaces a stand-in with every member and selects each in its own project', () => {
    const result = shim.finish(
      assignment({
        1: 'chromium/flow.spec.js › one\n',
        2: 'firefox/plain.spec.js › alone\n',
        3: '',
      }),
      groups,
      leaves
    );
    assert.strictEqual(
      result.testListFiles[1],
      '[chromium] › flow.spec.js › one\n[chromium] › flow.spec.js › two\n[chromium] › flow.spec.js › three\n'
    );
    assert.strictEqual(result.testListFiles[2], '[firefox] › plain.spec.js › alone\n');
    assert.strictEqual(result.testListFiles[3], '');
  });

  test('rejects a line that matches no listed test', () => {
    assert.throws(
      () => shim.finish(assignment({ 1: 'chromium/other.spec.js › x\n' }), groups, leaves),
      /unknown line/
    );
  });

  test('puts the test directory in front of every file when it differs from the config directory', () => {
    const nested = { ...list, config: { ...list.config, rootDir: '/consumer' } };
    const prepared = shim.prepare(nested, { chromium: null, firefox: null });
    assert.strictEqual(prepared.prefix, 'tests');
    const result = shim.finish(
      { shards: {}, testListFiles: { 1: 'tests/chromium/plain.spec.js › alone\n' } },
      prepared.groups,
      leaves,
      prepared.prefix
    );
    assert.strictEqual(result.testListFiles[1], '[chromium] › tests/plain.spec.js › alone\n');
  });

  test('refuses projects that do not share one test directory', () => {
    const split = {
      ...list,
      config: {
        ...list.config,
        projects: [
          { name: 'chromium', testDir: ROOT },
          { name: 'firefox', testDir: '/consumer/other' },
        ],
      },
    };
    assert.throws(
      () => shim.prepare(split, { chromium: null, firefox: null }),
      /share one testDir/
    );
  });

  test('hands the engine only the projects that carry tests', () => {
    const withSetup = {
      ...list,
      config: {
        ...list.config,
        projects: [{ name: 'setup', testDir: '/elsewhere' }, ...list.config.projects],
      },
    };
    const prepared = shim.prepare(withSetup, { chromium: null, firefox: null });
    assert.deepStrictEqual(
      prepared.list.config.projects.map((p) => p.name),
      ['chromium', 'firefox']
    );
  });

  test('ids and lines use the engine conventions', () => {
    const [leaf] = leaves;
    assert.strictEqual(shim.idOf(leaf), 'chromium/flow.spec.js::one');
    assert.strictEqual(shim.lineOf(leaf), 'chromium/flow.spec.js › one');
    assert.strictEqual(shim.playwrightLine(leaf), '[chromium] › flow.spec.js › one');
  });
});
