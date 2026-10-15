/** Tests for report assembly, negative-control verdicts and CLI exit codes, with stubbed runs. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sample = require('./samples/list-repeat-each-2.json');
const leaves = require('../harness/leaves.js');
const { configArgs, qualify } = require('../harness/index.js');
const { runNegativeControl } = require('../harness/negative-control.js');
const { main } = require('../harness/cli.js');

const dependencies = {
  setup: ['teardown'],
  teardown: [],
  chromium: ['setup', 'teardown'],
  firefox: ['setup', 'teardown'],
};
const intended = leaves.applyDependencies(leaves.parseList(sample), dependencies);
const listing = { leaves: intended, dependencies };
const dependencyLeaves = intended.filter((leaf) => leaf.dependency);
const primary = intended.filter((leaf) => !leaf.dependency);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempReport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-run-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'report.json');
}

function shardResult(index, runLeaves, extra = {}) {
  return {
    index,
    args: [],
    exitCode: 0,
    wallMs: 1000,
    durationMs: 900,
    leaves: runLeaves,
    output: '',
    ...extra,
  };
}

function sink() {
  const written = [];
  return { written, write: (text) => written.push(text) };
}

describe('qualify report', () => {
  const half = Math.ceil(primary.length / 2);
  const first = shardResult(1, [...dependencyLeaves, ...primary.slice(0, half)], {
    durationMs: 1000.4,
    wallMs: 1100,
  });
  const second = shardResult(2, [...dependencyLeaves, ...primary.slice(half)], {
    durationMs: 3000,
    wallMs: 3100,
  });

  function run(shards, options = {}) {
    const calls = [];
    const report = qualify(
      { cwd: '/consumer', shards: 2, ...options },
      {
        quiet: true,
        deps: {
          playwrightVersion: () => '9.9.9',
          listIntended: () => listing,
          runPartition: (opts, partition) => {
            calls.push(partition);
            return shards;
          },
        },
      }
    );
    return { report, calls };
  }

  test('assembles versions, shard summaries, slowest shard, imbalance and verdict', () => {
    const { report, calls } = run([first, second]);
    assert.strictEqual(report.playwright, '9.9.9');
    assert.strictEqual(report.node, process.version);
    assert.deepStrictEqual(report.shards, [
      { index: 1, durationMs: 1000, wallMs: 1100, leafCount: half, exitCode: 0 },
      { index: 2, durationMs: 3000, wallMs: 3100, leafCount: primary.length - half, exitCode: 0 },
    ]);
    assert.strictEqual(report.slowestShard, 2);
    assert.strictEqual(report.imbalance, (3000 - 2000) / 2000);
    assert.deepStrictEqual(report.violations, []);
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(calls[0], [{ args: ['--shard=1/2'] }, { args: ['--shard=2/2'] }]);
  });

  test('counts dependency executions per leaf and leaves them out of leafCount', () => {
    const { report } = run([first, second]);
    for (const leaf of dependencyLeaves)
      assert.strictEqual(report.dependencyExecutions[leaf.key], 2);
    assert.strictEqual(report.shards[0].leafCount, half);
  });

  test('is not ok when a leaf is dropped, and names it', () => {
    const { report } = run([first, { ...second, leaves: second.leaves.slice(0, -1) }]);
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(
      report.violations.map((violation) => violation.kind),
      ['missing']
    );
  });

  test('is not ok when a shard failed', () => {
    const { report } = run([first, { ...second, exitCode: 1 }]);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.violations[0].kind, 'shard-failed');
  });

  test('uses a supplied partition and listing instead of listing again', () => {
    const partition = [{ args: ['--custom'] }];
    const calls = [];
    const report = qualify(
      { cwd: '/consumer', partition, listing },
      {
        quiet: true,
        deps: {
          playwrightVersion: () => '1.0.0',
          listIntended: () => assert.fail('listed again'),
          runPartition: (opts, given) => {
            calls.push(given);
            return [shardResult(1, intended)];
          },
        },
      }
    );
    assert.deepStrictEqual(calls, [partition]);
    assert.strictEqual(report.ok, true);
  });
});

describe('runNegativeControl verdicts', () => {
  // Stub qualify keyed by control position: the clean one first, then missing, duplicate, serial.
  function runWith(reports) {
    let call = 0;
    const lines = [];
    const result = runNegativeControl(
      { cwd: '/consumer' },
      {
        log: (line) => lines.push(line),
        deps: {
          playwrightVersion: () => '9.9.9',
          listIntended: () => listing,
          qualify: () => reports[call++],
        },
      }
    );
    return { result, lines };
  }

  const accepted = { ok: true, violations: [] };
  const rejected = (kind) => ({ ok: false, violations: [{ kind }] });
  const good = [accepted, rejected('missing'), rejected('duplicate'), rejected('serial-split')];

  test('passes when the clean one is accepted and each broken one shows its kind', () => {
    const { result } = runWith(good);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.controls.map((control) => [control.name, control.expected, control.passed]),
      [
        ['clean partition', 'none', true],
        ['dropped leaf', 'missing', true],
        ['duplicated leaf', 'duplicate', true],
        ['split serial group', 'serial-split', true],
      ]
    );
  });

  test('records and logs the Playwright and Node versions', () => {
    const { result, lines } = runWith(good);
    assert.strictEqual(result.playwright, '9.9.9');
    assert.strictEqual(result.node, process.version);
    assert.strictEqual(lines[0], `Playwright 9.9.9, Node ${process.version}`);
  });

  test('fails when a broken partition is accepted', () => {
    const { result } = runWith([
      accepted,
      accepted,
      rejected('duplicate'),
      rejected('serial-split'),
    ]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.controls[1].passed, false);
  });

  test('fails when a broken partition is rejected with the wrong kind', () => {
    const { result } = runWith([
      accepted,
      rejected('shard-failed'),
      rejected('duplicate'),
      rejected('serial-split'),
    ]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.controls[1].passed, false);
  });

  test('passes a broken partition that shows its kind among others', () => {
    const many = { ok: false, violations: [{ kind: 'shard-failed' }, { kind: 'serial-split' }] };
    const { result } = runWith([accepted, rejected('missing'), rejected('duplicate'), many]);
    assert.strictEqual(result.ok, true);
  });

  test('fails when the clean partition is rejected', () => {
    const { result } = runWith([
      rejected('shard-failed'),
      rejected('missing'),
      rejected('duplicate'),
      rejected('serial-split'),
    ]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.controls[0].passed, false);
  });

  test('throws when the suite cannot form the controls', () => {
    assert.throws(
      () =>
        runNegativeControl(
          { cwd: '/consumer' },
          {
            deps: {
              playwrightVersion: () => '1',
              listIntended: () => ({
                leaves: intended.filter((leaf) => !leaf.serialGroup),
                dependencies,
              }),
              qualify: () => accepted,
            },
          }
        ),
      /serial group/
    );
  });
});

describe('main exit codes', () => {
  const passing = {
    playwright: '1',
    node: 'v',
    shards: [{ index: 1, durationMs: 1, wallMs: 1, leafCount: 1, exitCode: 0 }],
    slowestShard: 1,
    imbalance: 0,
    dependencyExecutions: {},
    violations: [],
    ok: true,
  };
  const failing = {
    ...passing,
    ok: false,
    violations: [{ kind: 'missing', key: 'k', detail: 'no shard ran this leaf' }],
  };

  function run(argv, deps) {
    const stdout = sink();
    const stderr = sink();
    const code = main([...argv, '--report', tempReport()], { stdout, stderr, ...deps });
    return { code, out: stdout.written.join(''), err: stderr.written.join('') };
  }

  test('returns 0 for a passing qualification', () => {
    const { code, out } = run([], { qualify: () => passing });
    assert.strictEqual(code, 0);
    assert.match(out, /Qualification passed/);
  });

  test('returns 1 for a violation and prints it', () => {
    const { code, err } = run([], { qualify: () => failing });
    assert.strictEqual(code, 1);
    assert.match(err, /violation missing k/);
  });

  test('returns 0 for a passing negative control', () => {
    const { code } = run(['--negative-control'], {
      runNegativeControl: () => ({ ok: true, controls: [] }),
    });
    assert.strictEqual(code, 0);
  });

  test('returns 1 for a failed negative control', () => {
    const { code, err } = run(['--negative-control'], {
      runNegativeControl: () => ({ ok: false, controls: [] }),
    });
    assert.strictEqual(code, 1);
    assert.match(err, /Negative control failed/);
  });

  test('writes the report file', () => {
    const report = tempReport();
    const code = main(['--report', report], {
      stdout: sink(),
      stderr: sink(),
      qualify: () => passing,
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(report, 'utf8')).ok, true);
  });

  test('returns 2 with an error line for a usage error', () => {
    const { code, err } = run(['--shards', '0'], {});
    assert.strictEqual(code, 2);
    assert.match(err, /^error: .*positive integer/);
  });

  test('returns 2 with an error line when the run throws', () => {
    const boom = () => {
      throw new Error('playwright test --list failed');
    };
    for (const [argv, deps] of [
      [[], { qualify: boom }],
      [['--negative-control'], { runNegativeControl: boom }],
    ]) {
      const { code, err } = run(argv, deps);
      assert.strictEqual(code, 2);
      assert.strictEqual(err, 'error: playwright test --list failed\n');
    }
  });
});

describe('configArgs', () => {
  test('keeps only the config selection of forwarded args', () => {
    assert.deepStrictEqual(
      configArgs([
        '--grep',
        'cart',
        '--project',
        'chromium',
        'firefox',
        '-c',
        'a.js',
        '--config=b.js',
      ]),
      ['-c', 'a.js', '--config=b.js']
    );
    assert.deepStrictEqual(configArgs(['--config', 'c.js', '--grep=x']), ['--config', 'c.js']);
    assert.deepStrictEqual(configArgs([]), []);
  });
});
