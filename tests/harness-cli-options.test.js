/**
 * Which arguments are options and which are their values, read from the help text of the
 * Playwright that is installed. A value can look like a flag, so a scan for `--test-list` finds it
 * where Playwright sees a pattern.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const {
  parseOptionArity,
  passesOption,
  playwrightOptionArity,
} = require('../harness/cli-options.js');
const { TEST_LIST_FLAGS } = require('../harness/partitions.js');
const { requireFixture } = require('./support/fixture.js');

const HELP = `Usage: playwright test [options] [test-filter...]

Options:
  --add-reporter <reporter>        Reporter to add on top of the configured
                                   reporters.
  -c, --config <file>              Configuration file, or a test directory with
                                   optional "playwright.config.c?(m)(j|t)s"
  --debug [mode]                   Run tests with Playwright Inspector.
  -g, --grep <grep>                Only run tests matching this regular
  -G, --grep-invert <grep>         Only run tests that do not match this regular
  -j, --workers <workers>          Number of concurrent workers
  --no-deps                        Do not run project dependencies
  --project <project-name...>      Only run tests from the specified list
  --test-list <file>               Path to a file containing a list of tests
  --test-list-invert <file>        Path to a file containing a list of tests
  -x                               Stop after the first failure
  -h, --help                       display help for command
`;

describe('parseOptionArity', () => {
  const arity = parseOptionArity(HELP);

  test('reads required, optional, variadic and flag options, with their short aliases', () => {
    assert.strictEqual(arity.get('--grep'), 'required');
    assert.strictEqual(arity.get('-g'), 'required');
    assert.strictEqual(arity.get('-G'), 'required');
    assert.strictEqual(arity.get('--config'), 'required');
    assert.strictEqual(arity.get('-c'), 'required');
    assert.strictEqual(arity.get('--debug'), 'optional');
    assert.strictEqual(arity.get('--project'), 'variadic');
    assert.strictEqual(arity.get('--test-list'), 'required');
    assert.strictEqual(arity.get('--no-deps'), 'none');
    assert.strictEqual(arity.get('-x'), 'none');
  });

  test('does not read the wrapped lines of a description as options', () => {
    assert.ok(!arity.has('reporters.'));
    assert.strictEqual(arity.size, 17);
  });

  test('reads the installed Playwright, which has the same options', () => {
    const cli = require.resolve('@playwright/test/cli', { paths: [requireFixture()] });
    const installed = playwrightOptionArity(cli);
    for (const [flag, kind] of arity) {
      if (flag === '--add-reporter') continue;
      assert.strictEqual(installed.get(flag), kind, flag);
    }
    assert.strictEqual(playwrightOptionArity(cli), installed);
  });
});

describe('passesOption', () => {
  const arity = parseOptionArity(HELP);
  const passes = (...args) => passesOption(args, arity, TEST_LIST_FLAGS);

  test('sees the list option in every spelling', () => {
    assert.strictEqual(passes('--test-list', 'f.txt'), true);
    assert.strictEqual(passes('--test-list=f.txt'), true);
    assert.strictEqual(passes('--test-list-invert', 'f.txt'), true);
    assert.strictEqual(passes('--test-list-invert=f.txt'), true);
  });

  test('sees it after options that take values and after flag clusters', () => {
    assert.strictEqual(passes('--workers', '1', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('--grep', 'x', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('-cflat.config.js', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('-c', 'flat.config.js', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('-gx', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('-x', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('-xg', '--test-list', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('-xg', '--test-list'), false);
    assert.strictEqual(passes('-xj', '--test-list'), false);
    assert.strictEqual(passes('--project', 'a', 'b', '--test-list', 'f.txt'), true);
    assert.strictEqual(passes('--debug', '--test-list', 'f.txt'), true);
  });

  test('does not see a value that looks like the list option', () => {
    assert.strictEqual(passes('--grep-invert', '--test-list'), false);
    assert.strictEqual(passes('--grep-invert=--test-list'), false);
    assert.strictEqual(passes('--grep', '--test-list'), false);
    assert.strictEqual(passes('-g', '--test-list'), false);
    assert.strictEqual(passes('-G', '--test-list-invert'), false);
    assert.strictEqual(passes('-c', '--test-list'), false);
    assert.strictEqual(passes('--workers', '--test-list'), false);
    assert.strictEqual(passes('--project', 'a', '--test-list-invert'), true);
  });

  test('reads a test filter that looks like a flag as the positional it is not', () => {
    assert.strictEqual(passes('--test-listing'), false);
    assert.strictEqual(passes('test-list'), false);
    assert.strictEqual(passes('--shard=1/2', '--no-deps'), false);
    assert.strictEqual(passes(), false);
  });

  test('stops at the separator', () => {
    assert.strictEqual(passes('--', '--test-list', 'f.txt'), false);
  });
});

describe('the options match what Playwright does with a value that looks like a flag', () => {
  const cwd = requireFixture();
  const cli = require.resolve('@playwright/test/cli', { paths: [cwd] });
  const listed = (...args) => {
    const run = spawnSync(process.execPath, [cli, 'test', '--list', ...args], {
      cwd,
      encoding: 'utf8',
    });
    return Number(/Total: (\d+) test/.exec(run.stdout)?.[1]);
  };

  test('--grep-invert takes --test-list as its pattern, so nothing is excluded', () => {
    const all = listed('-cunselectable-plain.config.js');
    assert.ok(all > 0);
    assert.strictEqual(
      listed('-cunselectable-plain.config.js', '--grep-invert', '--test-list'),
      all
    );
    assert.strictEqual(listed('-cunselectable-plain.config.js', '--grep-invert=--test-list'), all);
  });
});
