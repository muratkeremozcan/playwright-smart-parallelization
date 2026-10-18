/**
 * Table-driven tests of the one classification rule, against the real fixture and real Playwright
 * (setup with a teardown project, and chromium and firefox projects that depend on setup). Each row
 * is a forwarded selection. A leaf is a dependency, exempt from the exactly-once check, only when
 * another listed project needs its project; every other leaf is primary. `roles` maps
 * each project the selection lists to its role. A project that repeats under --repeat-each is a
 * top-level one, so the rows pin the repeat count with the role. For each row the clean partition
 * must pass every check, and dropping or repeating any primary leaf must be reported.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkAll } = require('../harness/index.js');
const { listFixture } = require('./support/fixture.js');

const TABLE = [
  {
    name: 'no flags: the browser projects are under test, setup and teardown are dependencies',
    forward: [],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: '--project chromium',
    forward: ['--project=chromium'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary' },
  },
  {
    name: '--project setup: setup is under test, its teardown is a dependency',
    forward: ['--project=setup'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--project teardown',
    forward: ['--project=teardown'],
    roles: { teardown: 'primary' },
  },
  {
    name: "--project setup teardown: teardown is still setup's dependency",
    forward: ['--project', 'setup', 'teardown'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--project chromium setup: chromium needs setup',
    forward: ['--project', 'chromium', 'setup'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary' },
  },
  {
    name: '--project with a wildcard',
    forward: ['--project=*'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: '--project in another case',
    forward: ['--project=SETUP'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--grep matching only setup, no --project',
    forward: ['--grep', 'prepare the environment'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '-g, the short form of --grep',
    forward: ['-g', 'prepare the environment'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--grep matching only teardown, no --project',
    forward: ['--grep', 'clean up the environment'],
    roles: { teardown: 'primary' },
  },
  {
    name: '--grep matching only the browser projects',
    forward: ['--grep', 'loads the page'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: "--grep-invert dropping setup's own test",
    forward: ['--grep-invert', 'prepare the environment'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: 'a test file filter that matches only the setup file',
    forward: ['global.setup.js'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--project setup chromium with a grep that matches nothing in chromium',
    forward: ['--project', 'setup', 'chromium', '--grep', 'prepare the environment'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--project setup chromium with a grep that keeps chromium',
    forward: ['--project', 'setup', 'chromium', '--grep', 'loads the page'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary' },
  },
  {
    name: 'a dependency project configured to repeat stays a dependency',
    config: 'repeat-setup.config.js',
    forward: [],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
    repeats: { setup: 2 },
  },
  {
    name: 'a configured-to-repeat dependency project, with --repeat-each 2',
    config: 'repeat-setup.config.js',
    forward: [],
    repeatEach: 2,
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
    repeats: { setup: 2 },
  },
  {
    name: 'a configured-to-repeat setup project selected by name is under test',
    config: 'repeat-setup.config.js',
    forward: ['--project=setup'],
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: 'a forwarded --repeat-each 2 does not flatten the comparison',
    forward: ['--repeat-each=2'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
    repeats: { chromium: 2, firefox: 2 },
  },
  {
    name: 'a forwarded --repeat-each 1 does not hide the top-level projects',
    forward: ['--repeat-each=1'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: '--grep-invert with --no-deps as its value: the flag is not set, dependencies stay',
    forward: ['--grep-invert', '--no-deps'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: '--project chromium setup --no-deps: both run on their own',
    forward: ['--project', 'chromium', 'setup', '--no-deps'],
    roles: { setup: 'primary', chromium: 'primary' },
  },
  {
    name: '--no-deps: every project runs on its own',
    forward: ['--no-deps'],
    roles: { setup: 'primary', teardown: 'primary', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: '--project chromium --no-deps',
    forward: ['--project=chromium', '--no-deps'],
    roles: { chromium: 'primary' },
  },
  {
    name: '--project setup --no-deps',
    forward: ['--project=setup', '--no-deps'],
    roles: { setup: 'primary' },
  },
  {
    name: '--grep prepare the environment --no-deps',
    forward: ['--grep', 'prepare the environment', '--no-deps'],
    roles: { setup: 'primary' },
  },
  {
    name: '--repeat-each 2: only the browser projects repeat',
    forward: [],
    repeatEach: 2,
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary', firefox: 'primary' },
  },
  {
    name: '--repeat-each 2 with --project setup: the selected setup repeats',
    forward: ['--project=setup'],
    repeatEach: 2,
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: '--repeat-each 2 with --project chromium setup: the needed setup does not',
    forward: ['--project', 'chromium', 'setup'],
    repeatEach: 2,
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary' },
  },
  {
    name: '--repeat-each 2 with a grep that matches only setup',
    forward: ['--grep', 'prepare the environment'],
    repeatEach: 2,
    roles: { setup: 'primary', teardown: 'dependency' },
  },
  {
    name: 'combination: --project chromium setup, grep, --no-deps, --repeat-each 2',
    forward: ['--project', 'chromium', 'setup', '--grep', 'prepare the environment', '--no-deps'],
    repeatEach: 2,
    roles: { setup: 'primary' },
  },
  {
    name: 'the alternative config, which has no firefox project',
    forward: ['-calt.config.js'],
    roles: { setup: 'dependency', teardown: 'dependency', chromium: 'primary' },
  },
];

const run = (leaf) => ({ ...leaf, outcome: 'expected' });
const kindsFor = (violations, key) =>
  violations.filter((violation) => violation.key === key).map((violation) => violation.kind);

/** `{ project: 'primary' | 'dependency' }`, asserting every leaf of a project agrees. */
function rolesOf(intended) {
  const roles = {};
  for (const leaf of intended.leaves) {
    const role = leaf.dependency ? 'dependency' : 'primary';
    assert.ok(!roles[leaf.project] || roles[leaf.project] === role, `${leaf.project} mixes roles`);
    roles[leaf.project] = role;
  }
  return roles;
}

describe('dependency classification over the selection, on real Playwright', () => {
  for (const row of TABLE) {
    describe(row.name, () => {
      const listed = () =>
        listFixture({ forward: row.forward, repeatEach: row.repeatEach, config: row.config });

      if (row.roles) {
        test('classifies each project', () => {
          assert.deepStrictEqual(rolesOf(listed()), row.roles);
        });
      }

      test('repeats exactly the top-level projects', () => {
        const repeats = {};
        for (const leaf of listed().leaves) {
          repeats[leaf.project] = Math.max(repeats[leaf.project] || 0, leaf.repeatIndex + 1);
        }
        const expected = row.repeatEach || 1;
        for (const [project, role] of Object.entries(rolesOf(listed()))) {
          const configured = (row.repeats || {})[project];
          assert.strictEqual(
            repeats[project],
            configured || (role === 'primary' ? expected : 1),
            `${project} (${role}) repeats`
          );
        }
      });

      test('accepts the clean partition', () => {
        const intended = listed();
        const shards = [
          { index: 1, exitCode: 0, leaves: intended.leaves.map(run) },
          { index: 2, exitCode: 0, leaves: [] },
        ];
        assert.deepStrictEqual(checkAll(intended.leaves, intended.dependencies, shards), []);
      });

      if (Object.values(row.roles).includes('dependency')) {
        test('rejects primary leaves run apart from the dependency leaves they need', () => {
          const intended = listed();
          const apart = [
            {
              index: 1,
              exitCode: 0,
              leaves: intended.leaves.filter((l) => !l.dependency).map(run),
            },
            { index: 2, exitCode: 0, leaves: [] },
          ];
          const missing = checkAll(intended.leaves, intended.dependencies, apart)
            .filter((violation) => violation.kind === 'dependency-missing')
            .map((violation) => violation.key);
          for (const leaf of intended.leaves.filter((l) => l.dependency)) {
            assert.ok(missing.includes(leaf.key), `${leaf.key} was not required`);
          }
        });
      }

      test('reports every primary leaf that is dropped or run twice', () => {
        const intended = listed();
        const primary = intended.leaves.filter((leaf) => !leaf.dependency);
        assert.ok(primary.length > 0, 'the row selects no primary leaf');
        for (const { key } of primary) {
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
    assert.ok(TABLE.some((row) => row.roles && Object.keys(row.roles).join() === 'setup'));
  });
});
