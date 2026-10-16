/**
 * The harness hands the user's arguments to Playwright exactly as given. These tests list the real
 * fixture with every spelling of the same selection and expect the same leaves, so nothing in the
 * harness reads, rebuilds or drops a flag. `alt.config.js` is the fixture without its firefox
 * project, which makes a config that reaches Playwright visible in the listing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { listIntended } = require('../harness/index.js');
const { requireFixture } = require('./support/fixture.js');

const cwd = requireFixture();
const keys = (options) =>
  listIntended({ cwd, ...options })
    .leaves.map((leaf) => leaf.key)
    .sort();
const projects = (options) => [
  ...new Set(listIntended({ cwd, ...options }).leaves.map((leaf) => leaf.project)),
];

describe('the config reaches Playwright in every spelling', () => {
  const spellings = {
    'the config option': { config: 'alt.config.js' },
    '-cFILE, attached': { forward: ['-calt.config.js'] },
    '-c FILE, detached': { forward: ['-c', 'alt.config.js'] },
    '--config=FILE': { forward: ['--config=alt.config.js'] },
    '--config FILE': { forward: ['--config', 'alt.config.js'] },
  };

  test('the default config lists the firefox project', () => {
    assert.ok(projects({}).includes('firefox'));
  });

  for (const [name, options] of Object.entries(spellings)) {
    test(`${name} selects the alternative config`, () => {
      assert.deepStrictEqual(projects(options).sort(), ['chromium', 'setup', 'teardown']);
    });
  }

  test('every spelling lists the same leaves, dependencies included', () => {
    const expected = listIntended({ cwd, config: 'alt.config.js' });
    for (const options of Object.values(spellings)) {
      assert.deepStrictEqual(listIntended({ cwd, ...options }), expected);
    }
  });
});

describe('a selection flag lists the same leaves in every spelling', () => {
  const equivalent = [
    [['-g', 'loads the page'], ['--grep=loads the page'], ['--grep', 'loads the page']],
    [['-gloads the page'], ['--grep', 'loads the page']],
    [['--project=chromium'], ['--project', 'chromium'], ['--project=CHROMIUM']],
    [
      ['-c', 'alt.config.js', '--project=setup'],
      ['-calt.config.js', '--project', 'setup'],
    ],
  ];
  for (const group of equivalent) {
    test(group.map((forward) => forward.join(' ')).join(' | '), () => {
      const [first, ...rest] = group;
      for (const forward of rest)
        assert.deepStrictEqual(keys({ forward }), keys({ forward: first }));
    });
  }

  test('flags that do not select tests change nothing', () => {
    const expected = keys({});
    for (const forward of [
      ['-j2'],
      ['-x'],
      ['--workers=2'],
      ['--max-failures=1'],
      ['--retries=0'],
    ]) {
      assert.deepStrictEqual(keys({ forward }), expected, forward.join(' '));
    }
  });
});

describe('a selection Playwright rejects fails the listing', () => {
  test('an unknown project name throws with the Playwright error', () => {
    assert.throws(() => listIntended({ cwd, forward: ['--project=nope'] }), /nope/);
  });

  test('a project the chosen config lacks throws', () => {
    assert.throws(
      () => listIntended({ cwd, config: 'alt.config.js', forward: ['--project=firefox'] }),
      /firefox/
    );
  });
});
