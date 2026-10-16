/** Tests for the partitions, the config file and the timings handling of drive.js. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const drive = require('../../drive');

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-flk-drive-test-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const report = drive.syntheticReport;

function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('shardEnv', () => {
  test('points the reporter at a report folder per shard and sets nothing else by default', () => {
    assert.deepStrictEqual(drive.shardEnv({ dir: '/d', index: 2 }), {
      FLAKINESS_OUTPUT_DIR: path.join('/d', 'flakiness-2'),
    });
  });

  test('sets the timings file, plain, upload and the extra reporters when asked', () => {
    const env = drive.shardEnv({
      dir: '/d',
      index: 1,
      timings: '/t.json',
      plain: true,
      upload: true,
      json: true,
      blob: true,
    });
    assert.strictEqual(env.PSP_FLK_TIMINGS, '/t.json');
    assert.strictEqual(env.PSP_FLK_PLAIN, '1');
    assert.strictEqual(env.PSP_FLK_UPLOAD, '1');
    assert.strictEqual(env.PSP_FLK_EXTRA, 'json,blob');
    assert.strictEqual(env.PLAYWRIGHT_JSON_OUTPUT_FILE, path.join('/d', 'report-1.json'));
    assert.strictEqual(env.PLAYWRIGHT_BLOB_OUTPUT_DIR, path.join('/d', 'blob-1'));
  });

  test('lets the caller environment override everything', () => {
    assert.strictEqual(
      drive.shardEnv({ dir: '/d', index: 1, env: { FLAKINESS_OUTPUT_DIR: '/x' } })
        .FLAKINESS_OUTPUT_DIR,
      '/x'
    );
  });
});

describe('partitionOf', () => {
  test('is native --shard=i/n for each shard, with the environment of that shard', () => {
    const partition = drive.partitionOf({ shards: 3, dir: '/d', timings: '/t.json' });
    assert.deepStrictEqual(
      partition.map((shard) => shard.args),
      [['--shard=1/3'], ['--shard=2/3'], ['--shard=3/3']]
    );
    assert.deepStrictEqual(
      partition.map((shard) => shard.env.FLAKINESS_OUTPUT_DIR),
      [1, 2, 3].map((index) => path.join('/d', `flakiness-${index}`))
    );
    assert.ok(partition.every((shard) => shard.env.PSP_FLK_TIMINGS === '/t.json'));
  });

  test('gives each shard its own Playwright output directory on request', () => {
    const partition = drive.partitionOf({ shards: 2, dir: '/d', output: true });
    assert.deepStrictEqual(partition[1].args, [
      '--shard=2/2',
      `--output=${path.join('/d', 'results-2')}`,
    ]);
  });

  test('keeps the timings file out of the environment when there is none', () => {
    const [shard] = drive.partitionOf({ shards: 1, dir: '/d' });
    assert.strictEqual('PSP_FLK_TIMINGS' in shard.env, false);
  });
});

describe('writeConfig', () => {
  test('writes a config that loads the shared config module for the project', () => {
    const dir = tempDir();
    const file = drive.writeConfig({ dir, project: '/p', fullyParallel: true });
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /require\(".*config\.js"\)\.configFor\(/);
    assert.match(source, /"project":"\/p"/);
    assert.match(source, /"fullyParallel":true/);
  });
});

describe('durations', () => {
  const tests = [
    ['chromium', 'a.spec.js', 'one', [100, 20]],
    ['firefox', 'a.spec.js', 'one', [60]],
    ['chromium', 'b.spec.js', 'two', [5]],
  ];

  test('testDurations with byEnvironment sums the attempts of a test per environment', () => {
    const file = write(tempDir(), 'r.json', report(tests));
    assert.deepStrictEqual(
      [...drive.testDurations(file, { byEnvironment: true })],
      [
        ['chromium › a.spec.js › one', 120],
        ['firefox › a.spec.js › one', 60],
        ['chromium › b.spec.js › two', 5],
      ]
    );
  });

  test('testDurations takes the longest environment of a test, as the reporter prices it', () => {
    const file = write(tempDir(), 'r.json', report(tests));
    assert.deepStrictEqual(
      [...drive.testDurations(file)],
      [
        ['a.spec.js › one', 120],
        ['b.spec.js › two', 5],
      ]
    );
  });

  test('testDurations finds a test that build stored once for environments of equal duration', () => {
    const dir = tempDir();
    const input = write(
      dir,
      'in.json',
      report([
        ['chromium', 'a.spec.js', 'one', [100]],
        ['firefox', 'a.spec.js', 'one', [100]],
      ])
    );
    const { file } = drive.buildHistory({ dir, reports: [input] });
    assert.strictEqual(drive.testDurations(file).get('a.spec.js › one'), 100);
  });

  test('testDurations refuses an attempt of an environment the file does not list', () => {
    const dir = tempDir();
    const broken = report(tests);
    broken.suites[0].tests[0].attempts[0].environmentIdx = 9;
    assert.throws(() => drive.testDurations(write(dir, 'b.json', broken)), /not listed/);
  });

  test('roundDurations rounds each attempt to a multiple of the step, in place', () => {
    const file = write(tempDir(), 'r.json', report(tests));
    drive.roundDurations(file, 50);
    const durations = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(
      durations.suites[0].tests[0].attempts.map((attempt) => attempt.duration),
      [100, 0]
    );
  });

  test('scaleDurations writes a scaled copy and leaves the original alone', () => {
    const dir = tempDir();
    const file = write(dir, 'r.json', report(tests));
    const copy = drive.scaleDurations(file, 1.5, path.join(dir, 'scaled.json'));
    assert.strictEqual(drive.testDurations(copy).get('a.spec.js › one'), 180);
    assert.strictEqual(drive.testDurations(file).get('a.spec.js › one'), 120);
  });

  test('mapDurations reaches the tests of nested suites', () => {
    const dir = tempDir();
    const nested = report(tests);
    nested.suites = [{ title: 'outer', type: 'suite', suites: nested.suites }];
    const file = write(dir, 'nested.json', nested);
    const out = drive.mapDurations(file, () => 0, path.join(dir, 'zero.json'));
    const durations = drive.testDurations(out, { byEnvironment: true });
    assert.strictEqual(durations.size, 3);
    assert.ok([...durations.values()].every((duration) => duration === 0));
  });

  test('mapDurations passes every attempt through the function', () => {
    const dir = tempDir();
    const file = write(dir, 'r.json', report(tests));
    const out = drive.mapDurations(file, () => 'abc', path.join(dir, 'text.json'));
    const durations = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(
      durations.suites.every((suite) =>
        suite.tests.every((test) => test.attempts.every((attempt) => attempt.duration === 'abc'))
      )
    );
  });
});

describe('buildHistory', () => {
  test('sums the attempts of a run and takes the maximum across runs', () => {
    const dir = tempDir();
    const first = write(dir, 'first.json', report([['chromium', 'a.spec.js', 'one', [100, 20]]]));
    const second = write(dir, 'second.json', report([['chromium', 'a.spec.js', 'one', [90]]]));
    const { file } = drive.buildHistory({ dir, reports: [first, second] });
    assert.strictEqual(drive.testDurations(file).get('a.spec.js › one'), 120);
  });

  test('never lowers an entry: an earlier timings file is an input like a report', () => {
    const dir = tempDir();
    const slow = write(dir, 'slow.json', report([['chromium', 'a.spec.js', 'one', [1000]]]));
    const fast = write(dir, 'fast.json', report([['chromium', 'a.spec.js', 'one', [10]]]));
    const first = drive.buildHistory({ dir, name: 'first', reports: [slow] });
    const { file } = drive.buildHistory({
      dir,
      name: 'second',
      existing: first.file,
      reports: [fast],
    });
    assert.strictEqual(drive.testDurations(file).get('a.spec.js › one'), 1000);
  });

  test('rounds the durations when asked', () => {
    const dir = tempDir();
    const input = write(dir, 'in.json', report([['chromium', 'a.spec.js', 'one', [126]]]));
    const { file } = drive.buildHistory({ dir, reports: [input], roundMs: 50 });
    assert.strictEqual(drive.testDurations(file).get('a.spec.js › one'), 150);
  });

  test('throws with the command error when an input cannot be read', () => {
    assert.throws(
      () => drive.buildHistory({ dir: tempDir(), reports: [path.join(tempDir(), 'absent.json')] }),
      /build failed: cannot read report/
    );
  });
});

describe('priceOf', () => {
  const one = 'a.spec.js › one';

  test('a project without an entry of its own is priced at the longest project', () => {
    const dir = tempDir();
    const input = write(dir, 'in.json', report([['chromium', 'a.spec.js', 'one', [300]]]));
    assert.strictEqual(drive.priceOf(input, 'chromium', one), 300);
    assert.strictEqual(drive.priceOf(input, 'firefox', one), 300);
  });

  test('is undefined for a test the file does not have', () => {
    const input = write(tempDir(), 'in.json', report([['chromium', 'a.spec.js', 'one', [1]]]));
    assert.strictEqual(drive.priceOf(input, 'chromium', 'a.spec.js › two'), undefined);
  });

  // A property of the installed package: `build` stores one attempt for a test whose projects took
  // equally long, and a shorter run merged into that file then lowers the project the stored
  // attempt did not name. A release that changes this fails here, and the history rows change.
  test('a shorter run lowers one project of a test that was stored once for both', () => {
    const dir = tempDir();
    const both = (chromium, firefox) =>
      report([
        ['chromium', 'a.spec.js', 'one', [chromium]],
        ['firefox', 'a.spec.js', 'one', [firefox]],
      ]);
    const slow = write(dir, 'slow.json', both(200, 200));
    const quick = write(dir, 'quick.json', both(6, 6));
    const first = drive.buildHistory({ dir, name: 'first', reports: [slow] });
    assert.deepStrictEqual(
      ['chromium', 'firefox'].map((project) => drive.priceOf(first.file, project, one)),
      [200, 200]
    );
    const second = drive.buildHistory({
      dir,
      name: 'second',
      existing: first.file,
      reports: [quick],
    });
    assert.deepStrictEqual(
      ['chromium', 'firefox'].map((project) => drive.priceOf(second.file, project, one)),
      [200, 6]
    );
  });
});

describe('reports and violations', () => {
  test('flakinessReports lists the reports the shards wrote and skips the others', () => {
    const dir = tempDir();
    const partition = drive.partitionOf({ shards: 2, dir });
    fs.mkdirSync(partition[1].env.FLAKINESS_OUTPUT_DIR);
    fs.writeFileSync(path.join(partition[1].env.FLAKINESS_OUTPUT_DIR, 'report.json'), '{}');
    assert.deepStrictEqual(drive.flakinessReports(partition), [
      path.join(partition[1].env.FLAKINESS_OUTPUT_DIR, 'report.json'),
    ]);
  });

  test('violationKinds counts the violations of each kind', () => {
    assert.deepStrictEqual(
      drive.violationKinds({
        violations: [{ kind: 'missing' }, { kind: 'duplicate' }, { kind: 'missing' }],
      }),
      { missing: 2, duplicate: 1 }
    );
  });
});
