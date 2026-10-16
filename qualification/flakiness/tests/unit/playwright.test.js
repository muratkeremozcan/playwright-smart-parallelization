/** Tests for the plan parser and the shard runner that list or run one shard. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listShard, parsePlan, plain, runShard, scrub } = require('../../playwright');
const { firstError } = require('../../scenarios/assignment');

const PLAN = `
[flakiness.io] balancing 3 shards
[flakiness.io]   timings file:   /t/timings.json
[flakiness.io]   duration hints: 40/54 tests (74%), the rest default to 1.0s
[flakiness.io]   shard loads:    1=9.1s, 2=9.1s, 3=7.3s
[flakiness.io]   balance:        93%
[flakiness.io] Running shard 2/3: 9.1s of work, ~2.3s across 4 workers
`;

describe('parsePlan', () => {
  test('reads the shard count, the hints, the loads and the running shard', () => {
    assert.deepStrictEqual(parsePlan(PLAN), {
      shards: 3,
      hinted: 40,
      tests: 54,
      loads: '1=9.1s, 2=9.1s, 3=7.3s',
      balancePercent: 93,
      runningShard: { current: 2, work: '9.1s of work' },
    });
  });

  test('reads the running shard line of a single worker', () => {
    const text = PLAN.replace(
      'Running shard 2/3: 9.1s of work, ~2.3s across 4 workers',
      'Shard 1/3: 9.1s of work'
    );
    assert.deepStrictEqual(parsePlan(text).runningShard, { current: 1, work: '9.1s of work' });
  });

  test('ignores terminal colors', () => {
    assert.strictEqual(parsePlan(`\u001b[33m${PLAN.trim()}\u001b[39m`).shards, 3);
  });

  test('returns null for an output with no plan', () => {
    assert.strictEqual(parsePlan('Running 3 tests using 1 worker'), null);
  });

  test('leaves the fields it cannot find empty', () => {
    const plan = parsePlan('[flakiness.io] balancing 2 shards');
    assert.deepStrictEqual(plan, {
      shards: 2,
      hinted: null,
      tests: null,
      loads: null,
      balancePercent: null,
      runningShard: null,
    });
  });
});

describe('plain', () => {
  test('removes terminal colors and nothing else', () => {
    assert.strictEqual(plain('\u001b[31mred\u001b[0m text'), 'red text');
  });
});

describe('scrub', () => {
  test('reduces each absolute path to its file name', () => {
    assert.strictEqual(
      scrub('cannot read "/var/folders/x/y/timings.json": ENOENT, open \'/tmp/a/b.json\''),
      'cannot read "timings.json": ENOENT, open \'b.json\''
    );
    assert.strictEqual(
      scrub('at preprocess (/srv/app/lib/playwright-test.js:18368:13)'),
      'at preprocess (playwright-test.js:18368:13)'
    );
  });

  test('reduces a Windows path', () => {
    assert.strictEqual(scrub('open C:\\work\\app\\t.json'), 'open t.json');
  });

  test('leaves text with no path alone, shard fractions included', () => {
    assert.strictEqual(scrub('Running shard 1/3: 9.1s of work'), 'Running shard 1/3: 9.1s of work');
  });
});

describe('firstError', () => {
  test('keeps the first Error line and reduces each quoted path to its file name', () => {
    const output = 'noise\nError: failed to read "/a/b/timings.json": nope\nError: second';
    assert.strictEqual(firstError(output), 'Error: failed to read "timings.json": nope');
  });

  test('is empty without an error', () => {
    assert.strictEqual(firstError('all good'), '');
  });
});

describe('runShard', () => {
  function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-shard-test-'));
    fs.symlinkSync(
      path.resolve(__dirname, '..', '..', '..', '..', 'fixtures', 'consumer', 'node_modules'),
      path.join(dir, 'node_modules')
    );
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(
      path.join(dir, 'tests', 'a.spec.js'),
      "const { test } = require('@playwright/test');\ntest('one', async () => {});\ntest('two', async () => {});\n"
    );
    fs.writeFileSync(
      path.join(dir, 'config.js'),
      "module.exports = { testDir: './tests', reporter: 'list', projects: [{ name: 'one' }] };\n"
    );
    return dir;
  }

  test('lists the leaves of a shard without running them', () => {
    const cwd = project();
    try {
      const result = listShard({ cwd, config: path.join(cwd, 'config.js') });
      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(
        result.leaves.map((leaf) => leaf.titlePath.at(-1)),
        ['one', 'two']
      );
      assert.ok(result.leaves.every((leaf) => leaf.outcome === 'skipped'));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('runs the shard and reports the outcome of each leaf', () => {
    const cwd = project();
    try {
      const result = runShard({ cwd, config: path.join(cwd, 'config.js') });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.leaves.every((leaf) => leaf.outcome === 'expected'));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('puts the wrap prefix in front of the command', () => {
    const cwd = project();
    try {
      const result = runShard({
        cwd,
        config: path.join(cwd, 'config.js'),
        wrap: ['sh', '-c', 'exit 4', 'wrapped'],
      });
      assert.strictEqual(result.exitCode, 4);
      assert.strictEqual(result.leaves, null);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
