/**
 * The harness contract. It supports and proves: --project, --grep, --grep-invert, --repeat-each,
 * --no-deps, --config or -c, file filters and project-level config (the classification table and
 * the listing tests run each against real Playwright). Flags that make the selection depend on
 * state outside the command line, or on sharding, which the engine under test owns, or that run
 * nothing, are rejected before any listing or run. The rejections below use a config whose listing
 * Playwright itself fails, so a rejection that came after a listing would fail these tests. A value
 * that only looks like such a flag is read the way the installed Playwright reads it.
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

const cwd = requireFixture();
const config = 'unnamed.config.js';
const REJECTED = [
  [['--last-failed'], /--last-failed is not supported.*earlier run/],
  [['--only-changed'], /--only-changed is not supported.*working tree/],
  [['--only-changed=main'], /--only-changed=main is not supported/],
  [['--shard=1/2'], /--shard=1\/2 is not supported.*owns sharding/],
  [['--shard', '1/2'], /--shard is not supported/],
  [['--list'], /--list is not supported.*executes nothing/],
  [['--grep', 'x', '--last-failed'], /--last-failed is not supported/],
  [['--grep-invert', 'x', '--list'], /--list is not supported/],
  [['-xg', 'x', '--shard=1/2'], /--shard=1\/2 is not supported/],
  [['--grep-invert=--list', '--only-changed'], /--only-changed is not supported/],
  [['--'], /-- is not supported.*after it/],
  [['--project=chromium', '--', 'foo'], /-- is not supported/],
  [['--grep', '--', '--', '--list'], /-- is not supported/],
];

describe('flags outside the contract are rejected before any run', () => {
  for (const [forward, message] of REJECTED) {
    describe(forward.join(' '), () => {
      test('assertSupportedSelection throws', () => {
        assert.throws(() => assertSupportedSelection({ cwd, forward }), message);
      });

      test('listIntended throws without listing', () => {
        assert.throws(() => listIntended({ cwd, config, forward }), message);
      });

      test('runPartition throws without running', () => {
        assert.throws(() => runPartition({ cwd, config, forward }, [{ args: [] }]), message);
      });

      test('qualify throws without listing', () => {
        assert.throws(() => qualify({ cwd, config, shards: 2, forward }, { quiet: true }), message);
      });

      test('the negative control throws without listing', () => {
        assert.throws(() => runNegativeControl({ cwd, config, forward }), message);
      });

      test('the CLI exits 2 with the error', () => {
        const written = [];
        const code = main(['--cwd', cwd, '--config', config, '--', ...forward], {
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
    // Values that look like a rejected flag or the separator.
    ['--grep-invert', '--list'],
    ['--grep-invert', '--shard'],
    ['--grep-invert', '--last-failed'],
    ['--grep-invert', '--only-changed'],
    ['--grep=--shard'],
    ['--grep-invert=--list'],
    ['-g', '--list'],
    ['-G', '--last-failed'],
    ['-g--only-changed'],
    ['-xG', '--shard'],
    ['--project', '--list'],
    ['--grep', '--'],
  ];
  for (const forward of supported) {
    test(forward.join(' '), () => {
      assert.doesNotThrow(() => assertSupportedSelection({ cwd, forward }));
    });
  }

  test('a partition may still shard through its own args', () => {
    assert.doesNotThrow(() => assertSupportedSelection({ cwd, forward: [] }));
  });

  test('a selection that names no rejected flag needs no installed Playwright', () => {
    const missing = '/nonexistent/consumer';
    assert.doesNotThrow(() => assertSupportedSelection({ cwd: missing, forward: ['-g', 'x'] }));
  });
});

describe('a value that looks like a rejected flag selects what Playwright selects', () => {
  const cli = path.join(cwd, 'node_modules', '@playwright', 'test', 'cli');
  const listed = (forward) => {
    const run = spawnSync(process.execPath, [cli, 'test', '--list', ...forward], {
      cwd,
      encoding: 'utf8',
    });
    assert.strictEqual(run.status, 0, run.stderr);
    return Number(/Total: (\d+) tests?/.exec(run.stdout)?.[1] ?? 0);
  };
  const CASES = [
    ['--grep-invert', '--list'],
    ['--grep-invert', '--shard'],
    ['--grep-invert', '--last-failed'],
    ['--grep-invert', '--only-changed'],
    ['--grep-invert=--shard'],
    ['-G', '--list'],
    ['--grep-invert', '--'],
    ['--grep', '--list', '--pass-with-no-tests'],
    ['--grep=--shard', '--pass-with-no-tests'],
    ['-g', '--last-failed', '--pass-with-no-tests'],
  ];
  for (const forward of CASES) {
    test(forward.join(' '), () => {
      const count = listed(forward);
      if (count === 0) {
        assert.throws(() => listIntended({ cwd, forward }), /no test to qualify/);
      } else {
        assert.strictEqual(listIntended({ cwd, forward }).leaves.length, count);
      }
    });
  }

  test('the inverted patterns keep the whole suite', () => {
    assert.strictEqual(listed(['--grep-invert', '--list']), listed([]));
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
      name: 'projects without a name',
      options: { config: 'unnamed.config.js' },
      message: /project #1 has no name.*unique non-empty name/,
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

  test('a reporter error reaches the user without the stack around it', () => {
    assert.throws(
      () => listIntended({ cwd: real, config: 'unnamed.config.js' }),
      (error) =>
        /^project #1 has no name/.test(error.message) && !/--list failed/.test(error.message)
    );
  });

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
