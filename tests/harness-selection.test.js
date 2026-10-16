/**
 * Table-driven tests of the one classification rule. Each row is a forwarded selection against a
 * stub Playwright (setup with a teardown project, chromium depending on setup). A project is a
 * dependency, exempt from exactly-once coverage, only when a surviving selected project needs it.
 * Every other leaf is primary. For each row the clean partition must pass every check, and
 * dropping or repeating any primary leaf must be reported.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { checkAll, listIntended } = require('../harness/index.js');
const { createStubConsumer } = require('./support/stub-playwright.js');

let cwd;
before(() => {
  cwd = createStubConsumer();
});
after(() => fs.rmSync(cwd, { recursive: true, force: true }));

const SETUP = 'setup|setup.js|prepare|#0';
const TEARDOWN = 'teardown|teardown.js|clean up|#0';
const works = (repeats) =>
  Array.from({ length: repeats }, (_, i) => [
    `chromium|a.spec.js|works|#${i}`,
    `chromium|a.spec.js|also works|#${i}`,
  ]).flat();

// primary and dependency are the leaf keys that must be classified that way.
const TABLE = [
  {
    name: 'no flags: the browser project is under test, setup and teardown are dependencies',
    forward: [],
    primary: works(1),
    dependency: [SETUP, TEARDOWN],
  },
  {
    name: '--project chromium',
    forward: ['--project=chromium'],
    primary: works(1),
    dependency: [SETUP, TEARDOWN],
  },
  {
    name: '--project setup: setup is under test, its teardown is a dependency',
    forward: ['--project=setup'],
    primary: [SETUP],
    dependency: [TEARDOWN],
  },
  {
    name: '--project teardown',
    forward: ['--project=teardown'],
    primary: [TEARDOWN],
    dependency: [],
  },
  {
    name: "--project setup teardown: teardown is still setup's dependency",
    forward: ['--project', 'setup', 'teardown'],
    primary: [SETUP],
    dependency: [TEARDOWN],
  },
  {
    name: '--project chromium setup: chromium needs setup',
    forward: ['--project', 'chromium', 'setup'],
    primary: works(1),
    dependency: [SETUP, TEARDOWN],
  },
  {
    name: '--grep matching only setup, no --project',
    forward: ['--grep', 'prepare'],
    primary: [SETUP],
    dependency: [TEARDOWN],
  },
  {
    name: '--grep matching only teardown, no --project',
    forward: ['--grep', 'clean up'],
    primary: [TEARDOWN],
    dependency: [],
  },
  {
    name: '--grep matching only chromium, no --project',
    forward: ['--grep', 'works'],
    primary: works(1),
    dependency: [SETUP, TEARDOWN],
  },
  {
    name: '--project setup chromium with a grep that matches nothing in chromium',
    forward: ['--project', 'setup', 'chromium', '--grep', 'prepare'],
    primary: [SETUP],
    dependency: [TEARDOWN],
  },
  {
    name: '--project setup chromium with a grep that keeps chromium',
    forward: ['--project', 'setup', 'chromium', '--grep', 'works'],
    primary: works(1),
    dependency: [SETUP, TEARDOWN],
  },
  {
    name: '--no-deps: every project runs on its own',
    forward: ['--no-deps'],
    primary: [SETUP, TEARDOWN, ...works(1)],
    dependency: [],
  },
  {
    name: '--project chromium --no-deps',
    forward: ['--project=chromium', '--no-deps'],
    primary: works(1),
    dependency: [],
  },
  {
    name: '--project setup --no-deps',
    forward: ['--project=setup', '--no-deps'],
    primary: [SETUP],
    dependency: [],
  },
  {
    name: '--grep prepare --no-deps',
    forward: ['--grep', 'prepare', '--no-deps'],
    primary: [SETUP],
    dependency: [],
  },
  {
    name: '--repeat-each 2: only the browser project repeats',
    forward: [],
    repeatEach: 2,
    primary: works(2),
    dependency: [SETUP, TEARDOWN],
  },
  {
    name: '--repeat-each 2 with --project setup',
    forward: ['--project=setup'],
    repeatEach: 2,
    primary: [SETUP],
    dependency: [TEARDOWN],
  },
  {
    name: '--repeat-each 2 with a grep that matches only setup',
    forward: ['--grep', 'prepare'],
    repeatEach: 2,
    primary: [SETUP],
    dependency: [TEARDOWN],
  },
  {
    name: 'combination: --project chromium setup, grep prepare, --no-deps, --repeat-each 2',
    forward: ['--project', 'chromium', 'setup', '--grep', 'prepare', '--no-deps'],
    repeatEach: 2,
    primary: [SETUP],
    dependency: [],
  },
];

const run = (leaf) => ({ ...leaf, outcome: 'expected' });
const kindsFor = (violations, key) =>
  violations.filter((violation) => violation.key === key).map((violation) => violation.kind);

describe('dependency classification over the effective selection', () => {
  for (const row of TABLE) {
    describe(row.name, () => {
      const listed = () => listIntended({ cwd, forward: row.forward, repeatEach: row.repeatEach });
      const byRole = (intended, wanted) =>
        intended.leaves
          .filter((leaf) => leaf.dependency === wanted)
          .map((leaf) => leaf.key)
          .sort();

      test('classifies each leaf', () => {
        const intended = listed();
        assert.deepStrictEqual(byRole(intended, false), [...row.primary].sort());
        assert.deepStrictEqual(byRole(intended, true), [...row.dependency].sort());
      });

      test('accepts the clean partition', () => {
        const intended = listed();
        const shards = [
          { index: 1, exitCode: 0, leaves: intended.leaves.map(run) },
          { index: 2, exitCode: 0, leaves: [] },
        ];
        assert.deepStrictEqual(checkAll(intended.leaves, intended.dependencies, shards), []);
      });

      test('reports every primary leaf that is dropped or run twice', () => {
        const intended = listed();
        for (const key of row.primary) {
          const dropped = [
            {
              index: 1,
              exitCode: 0,
              leaves: intended.leaves.filter((l) => l.key !== key).map(run),
            },
            { index: 2, exitCode: 0, leaves: [] },
          ];
          assert.ok(
            kindsFor(checkAll(intended.leaves, intended.dependencies, dropped), key).includes(
              'missing'
            ),
            `dropping ${key} was accepted`
          );
          const twice = [
            { index: 1, exitCode: 0, leaves: intended.leaves.map(run) },
            { index: 2, exitCode: 0, leaves: [run(intended.leaves.find((l) => l.key === key))] },
          ];
          assert.ok(
            kindsFor(checkAll(intended.leaves, intended.dependencies, twice), key).includes(
              'duplicate'
            ),
            `running ${key} twice was accepted`
          );
        }
      });
    });
  }

  test('the table covers a dependency project as the only thing selected', () => {
    assert.ok(TABLE.some((row) => row.primary.includes(SETUP) && row.primary.length === 1));
  });
});
