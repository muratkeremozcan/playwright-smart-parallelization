/**
 * The harness contract. It supports and proves: --project, --grep, --grep-invert, --repeat-each,
 * --no-deps, --config or -c, file filters and project-level config (the classification table and
 * the listing tests run each against real Playwright). Flags that make the selection depend on
 * state outside the command line, or on sharding, which the engine under test owns, or that run
 * nothing, are rejected before any listing or run. The working directory below does not exist, so
 * a rejection that came from Playwright instead of the harness would fail these tests.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  assertSupportedSelection,
  listIntended,
  qualify,
  runPartition,
} = require('../harness/index.js');
const { runNegativeControl } = require('../harness/negative-control.js');
const { main } = require('../harness/cli.js');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { requireFixture } = require('./support/fixture.js');

const cwd = '/nonexistent/consumer';
const REJECTED = [
  [['--last-failed'], /--last-failed is not supported.*earlier run/],
  [['--only-changed'], /--only-changed is not supported.*working tree/],
  [['--only-changed=main'], /--only-changed=main is not supported/],
  [['--shard=1/2'], /--shard=1\/2 is not supported.*owns sharding/],
  [['--shard', '1/2'], /--shard is not supported/],
  [['--list'], /--list is not supported.*executes nothing/],
  [['--grep', 'x', '--last-failed'], /--last-failed is not supported/],
  [['--'], /-- is not supported.*after it/],
  [['--project=chromium', '--', 'foo'], /-- is not supported/],
];

describe('flags outside the contract are rejected before any run', () => {
  for (const [forward, message] of REJECTED) {
    describe(forward.join(' '), () => {
      test('assertSupportedSelection throws', () => {
        assert.throws(() => assertSupportedSelection(forward), message);
      });

      test('listIntended throws without listing', () => {
        assert.throws(() => listIntended({ cwd, forward }), message);
      });

      test('runPartition throws without running', () => {
        assert.throws(() => runPartition({ cwd, forward }, [{ args: [] }]), message);
      });

      test('qualify throws without listing', () => {
        assert.throws(() => qualify({ cwd, shards: 2, forward }, { quiet: true }), message);
      });

      test('the negative control throws without listing', () => {
        assert.throws(() => runNegativeControl({ cwd, forward }), message);
      });

      test('the CLI exits 2 with the error', () => {
        const written = [];
        const code = main(['--cwd', cwd, '--', ...forward], {
          stdout: { write: () => {} },
          stderr: { write: (text) => written.push(text) },
        });
        assert.strictEqual(code, 2);
        assert.match(written.join(''), message);
      });
    });
  }
});

describe('flags inside the contract pass the check', () => {
  const supported = [
    ['--project=chromium'],
    ['--project', 'chromium', 'setup'],
    ['--grep', 'x'],
    ['-g', 'x'],
    ['--grep-invert', 'x'],
    ['--grep-invert', '--no-deps'],
    ['--repeat-each=2'],
    ['--no-deps'],
    ['-c', 'alt.config.js'],
    ['-calt.config.js'],
    ['--config=alt.config.js'],
    ['global.setup.js'],
    ['-j2', '-x', '--retries=0'],
  ];
  for (const forward of supported) {
    test(forward.join(' '), () => {
      assert.doesNotThrow(() => assertSupportedSelection(forward));
    });
  }

  test('a partition may still shard through its own args', () => {
    assert.doesNotThrow(() => assertSupportedSelection([]));
  });
});

describe('a selection the harness cannot qualify is rejected on real Playwright', () => {
  const real = requireFixture();
  const CASES = [
    {
      name: 'a config that shards the run',
      options: { config: 'shard.config.js' },
      message: /config shards the run \(shard 1 of 2\).*owns sharding/,
    },
    {
      name: 'a config that shards the run, named by a forwarded flag',
      options: { forward: ['-cshard.config.js'] },
      message: /config shards the run/,
    },
    {
      name: 'an empty selection that Playwright accepts with --pass-with-no-tests',
      options: { forward: ['--grep', 'no such test', '--pass-with-no-tests'] },
      message: /no test to qualify/,
    },
  ];

  for (const { name, options, message } of CASES) {
    describe(name, () => {
      test('listIntended throws', () => {
        assert.throws(() => listIntended({ cwd: real, ...options }), message);
      });

      test('qualify throws instead of passing', () => {
        assert.throws(
          () => qualify({ cwd: real, shards: 2, ...options }, { quiet: true }),
          message
        );
      });

      test('the negative control throws', () => {
        assert.throws(() => runNegativeControl({ cwd: real, ...options }), message);
      });

      test('the CLI exits 2 with the error', () => {
        const written = [];
        const argv = ['--cwd', real];
        if (options.config) argv.push('--config', options.config);
        argv.push('--', ...(options.forward || []));
        const code = main(argv, {
          stdout: { write: () => {} },
          stderr: { write: (text) => written.push(text) },
        });
        assert.strictEqual(code, 2);
        assert.match(written.join(''), message);
      });
    });
  }

  test('Playwright itself exits 0 for the empty selection, so the harness must check', () => {
    const forward = ['--grep', 'no such test', '--pass-with-no-tests'];
    const run = spawnSync(
      process.execPath,
      [path.join(real, 'node_modules', '@playwright', 'test', 'cli'), 'test', '--list', ...forward],
      { cwd: real, encoding: 'utf8' }
    );
    assert.strictEqual(run.status, 0);
  });
});
