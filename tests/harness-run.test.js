/** Tests for report assembly, negative-control verdicts and CLI exit codes, with stubbed runs. */

const { test, describe, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sample = require('./samples/list-repeat-each-2.json');
const leaves = require('../harness/leaves.js');
const { configArgs, listIntended, qualify, runPartition } = require('../harness/index.js');
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
    leaves: runLeaves.map((leaf) => ({ outcome: 'expected', ...leaf })),
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

  test('is not ok when every leaf skipped at runtime, and names each as not-executed', () => {
    const skip = (shardRun) => ({
      ...shardRun,
      leaves: shardRun.leaves.map((leaf) => ({ ...leaf, outcome: 'skipped' })),
    });
    const { report } = run([skip(first), skip(second)]);
    assert.strictEqual(report.ok, false);
    const notExecuted = report.violations.filter((violation) => violation.kind === 'not-executed');
    assert.strictEqual(notExecuted.length, first.leaves.length + second.leaves.length);
    assert.deepStrictEqual(
      new Set(report.violations.map((violation) => violation.kind)),
      new Set(['not-executed'])
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
  // Stub qualify keyed by control position: the clean one first, then missing, duplicate, serial,
  // not-executed, then the dependency selection pair: clean and missing.
  const selectedListing = { ...listing, selected: true };

  function runWith(reports, { options = { cwd: '/consumer' } } = {}) {
    let call = 0;
    const lines = [];
    const qualified = [];
    const listed = [];
    const result = runNegativeControl(options, {
      log: (line) => lines.push(line),
      deps: {
        playwrightVersion: () => '9.9.9',
        listIntended: (given) => {
          listed.push(given);
          return listed.length === 1 ? listing : selectedListing;
        },
        qualify: (given) => {
          qualified.push(given);
          return reports[call++];
        },
      },
    });
    return { result, lines, qualified, listed };
  }

  const accepted = { ok: true, violations: [] };
  const rejected = (kind) => ({ ok: false, violations: [{ kind }] });
  const everyPrimarySkipped = {
    ok: false,
    violations: primary.map((leaf) => ({ kind: 'not-executed', key: leaf.key })),
  };
  const good = [
    accepted,
    rejected('missing'),
    rejected('duplicate'),
    rejected('serial-split'),
    everyPrimarySkipped,
    accepted,
    rejected('missing'),
  ];
  const clean = [0, 5];
  const broken = [1, 2, 3, 4, 6];
  const swap = (position, report) =>
    good.map((item, index) => (index === position ? report : item));

  test('passes when each clean one is accepted and each broken one shows its kind', () => {
    const { result } = runWith(good);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.controls.map((control) => [control.name, control.expected, control.passed]),
      [
        ['clean partition', 'none', true],
        ['dropped leaf', 'missing', true],
        ['duplicated leaf', 'duplicate', true],
        ['split serial group', 'serial-split', true],
        ['skipped at runtime', 'not-executed', true],
        ['selected setup project, clean', 'none', true],
        ['selected setup project, only teardown runs', 'missing', true],
      ]
    );
  });

  test('records and logs the Playwright and Node versions', () => {
    const { result, lines } = runWith(good);
    assert.strictEqual(result.playwright, '9.9.9');
    assert.strictEqual(result.node, process.version);
    assert.strictEqual(lines[0], `Playwright 9.9.9, Node ${process.version}`);
  });

  for (const position of broken) {
    test(`fails when broken control ${position} is accepted`, () => {
      const { result } = runWith(swap(position, accepted));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.controls[position].passed, false);
    });

    test(`fails when broken control ${position} is rejected with the wrong kind`, () => {
      const { result } = runWith(swap(position, rejected('shard-failed')));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.controls[position].passed, false);
    });
  }

  for (const position of clean) {
    test(`fails when clean control ${position} is rejected`, () => {
      const { result } = runWith(swap(position, rejected('shard-failed')));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.controls[position].passed, false);
    });
  }

  test('passes a broken partition that shows its kind among others', () => {
    const many = { ok: false, violations: [{ kind: 'shard-failed' }, { kind: 'serial-split' }] };
    const { result } = runWith(swap(3, many));
    assert.strictEqual(result.ok, true);
  });

  test('fails when the skipped control flags only some of the primary leaves', () => {
    const some = {
      ok: false,
      violations: [{ kind: 'not-executed', key: primary[0].key }],
    };
    const { result } = runWith(swap(4, some));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.controls[4].passed, false);
  });

  test('lists the controls of the forwarded selection from the first listing', () => {
    const { qualified } = runWith(good);
    for (const position of [0, 1, 2, 3, 4])
      assert.strictEqual(qualified[position].listing, listing);
  });

  test('skips every test at runtime in the skipped control and no other', () => {
    const { qualified } = runWith(good);
    const skipEnv = { PSP_FIXTURE_SKIP_ALL: '1' };
    assert.strictEqual(qualified[4].partition.length, 2);
    for (const shard of qualified[4].partition) assert.deepStrictEqual(shard.env, skipEnv);
    for (const position of [0, 1, 2, 3, 5, 6]) {
      for (const shard of qualified[position].partition) assert.strictEqual(shard.env, undefined);
    }
  });

  test('lists the dependency selection again and keeps the config selection only', () => {
    const { qualified, listed } = runWith(good, {
      options: { cwd: '/consumer', forward: ['--grep', 'cart', '-c', 'a.js'] },
    });
    assert.deepStrictEqual(listed[1].forward, ['-c', 'a.js', '--project=setup']);
    assert.deepStrictEqual(qualified[0].forward, ['--grep', 'cart', '-c', 'a.js']);
    assert.deepStrictEqual(qualified[5].forward, ['-c', 'a.js', '--project=setup']);
    assert.deepStrictEqual(qualified[5].partition, [
      { args: ['--shard=1/2'] },
      { args: ['--shard=2/2'] },
    ]);
    assert.strictEqual(qualified[5].listing, selectedListing);
    assert.deepStrictEqual(qualified[6].forward, ['-c', 'a.js']);
    assert.deepStrictEqual(qualified[6].partition, [{ args: ['--project=teardown'] }]);
    assert.strictEqual(qualified[6].listing, selectedListing);
  });

  test('throws when the suite cannot form the controls', () => {
    const run = (given, map) =>
      assert.throws(
        () =>
          runNegativeControl(
            { cwd: '/consumer' },
            {
              deps: {
                playwrightVersion: () => '1',
                listIntended: () => given,
                qualify: () => accepted,
              },
            }
          ),
        map
      );
    run({ leaves: intended.filter((leaf) => !leaf.serialGroup), dependencies }, /serial group/);
    run(
      { leaves: intended, dependencies: { setup: [], teardown: [], chromium: ['setup'] } },
      /dependency project/
    );
  });
});

describe('listIntended and runPartition against a stub Playwright', () => {
  // A consumer directory whose `@playwright/test/cli` lists a fixed suite (setup with a teardown
  // project, chromium depending on setup) and, on a run, writes the shard's reporter file.
  const cli = `
    const fs = require('node:fs');
    const args = process.argv.slice(3);
    const dependencies = { setup: ['teardown'], chromium: ['setup', 'teardown'], teardown: [] };
    const tests = [
      ['setup', 'setup.js', 'prepare'],
      ['teardown', 'teardown.js', 'clean up'],
      ['chromium', 'a.spec.js', 'works'],
    ];
    if (args.includes('--list')) {
      const named = args.filter((arg) => arg.startsWith('--project=')).map((arg) => arg.slice(10));
      const wanted = named.length ? named.flatMap((name) => [name, ...dependencies[name]]) : null;
      const chosen = tests.filter(([project]) => !wanted || wanted.includes(project));
      const specs = chosen.map(([project, file, title]) => ({
        title, file, line: 1, column: 1, tests: [{ projectName: project, annotations: [] }],
      }));
      const projects = tests.map(([name]) => ({ name, testDir: '/t' }));
      process.stdout.write(JSON.stringify({
        config: { projects },
        suites: specs.map((spec) => ({ title: spec.file, file: spec.file, specs: [spec] })),
      }));
    } else {
      const leaves = [{ key: process.env.PSP_STUB_MARK || 'unmarked' }];
      fs.writeFileSync(process.env.PSP_HARNESS_RESULT, JSON.stringify({ durationMs: 5, leaves }));
      process.exit(Number(process.env.PSP_STUB_EXIT || 0));
    }
  `;
  let cwd;
  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-stub-playwright-'));
    tempDirs.push(cwd);
    const pkg = path.join(cwd, 'node_modules', '@playwright', 'test');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/test' }));
    fs.writeFileSync(path.join(pkg, 'cli.js'), cli);
  });

  const roles = (listed) =>
    listed.leaves.map((leaf) => [leaf.project, leaf.dependency ? 'dependency' : 'primary']);

  test('treats setup and teardown as dependencies when no project is selected by name', () => {
    assert.deepStrictEqual(roles(listIntended({ cwd })), [
      ['setup', 'dependency'],
      ['teardown', 'dependency'],
      ['chromium', 'primary'],
    ]);
  });

  test('makes a dependency project selected by name primary and keeps its teardown a dependency', () => {
    assert.deepStrictEqual(roles(listIntended({ cwd, forward: ['--project=setup'] })), [
      ['setup', 'primary'],
      ['teardown', 'dependency'],
    ]);
  });

  test('keeps setup a dependency when chromium, which needs it, is selected too', () => {
    const forward = ['--project=chromium', '--project=setup'];
    assert.deepStrictEqual(roles(listIntended({ cwd, forward })), [
      ['setup', 'dependency'],
      ['teardown', 'dependency'],
      ['chromium', 'primary'],
    ]);
  });

  test('runs each shard with its own env on top of the reporter path', () => {
    const shards = runPartition({ cwd }, [
      { args: [], env: { PSP_STUB_MARK: 'first' } },
      { args: [], env: { PSP_STUB_MARK: 'second', PSP_STUB_EXIT: '3' } },
      { args: [] },
    ]);
    assert.deepStrictEqual(
      shards.map((shard) => [shard.index, shard.exitCode, shard.leaves[0].key]),
      [
        [1, 0, 'first'],
        [2, 3, 'second'],
        [3, 0, 'unmarked'],
      ]
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
