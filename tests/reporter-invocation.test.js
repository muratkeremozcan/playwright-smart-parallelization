'use strict';

/**
 * The two flags of the user's command that change the selection where the config does not show
 * it, on real Playwright: under `--no-deps` the setup, teardown and leaf projects are ordinary
 * projects, so every selected test is in the corpus and runs once, in native and balanced mode,
 * with no `--project` and with several; with dependencies on, setup runs on every shard that needs
 * it; and `--last-failed`, which Playwright applies after the split, stops every shard before any
 * test, while the same command with the Action disabled runs as plain Playwright.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPORTER, checkRun, tempDir, writeSnapshot } = require('./support/action');
const { FIXTURE, requireFixture } = require('./support/fixture');
const { emptyHistory } = require('../lib/history');
const { testKey } = require('../lib/plan/estimate');

const KEY = 'invocation-key';
let dir;
let snapshot;

/**
 * A browser-free project with `setup` (torn down by `cleanup`) and `leaf`, which depends on
 * `setup`, two files of two tests each. `FAIL=<title>` makes that test fail.
 */
function writeProject() {
  const root = tempDir('psp-invocation-');
  fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(
    path.join(root, 'playwright.config.js'),
    `module.exports = {
  testDir: '.',
  workers: 1,
  reporter: 'null',
  projects: [
    { name: 'setup', testMatch: /setup\\.spec\\.js/, teardown: 'cleanup' },
    { name: 'cleanup', testMatch: /cleanup\\.spec\\.js/ },
    { name: 'leaf', testMatch: /leaf-.*\\.spec\\.js/, dependencies: ['setup'] },
  ],
};\n`
  );
  const spec = (titles) =>
    `const { test } = require('@playwright/test');\n` +
    titles
      .map(
        (t) =>
          `test('${t}', async () => {\n  if (process.env.FAIL === '${t}') throw new Error('fails on purpose');\n});\n`
      )
      .join('');
  fs.writeFileSync(path.join(root, 'setup.spec.js'), spec(['setup-one', 'setup-two']));
  fs.writeFileSync(path.join(root, 'cleanup.spec.js'), spec(['cleanup-one']));
  fs.writeFileSync(path.join(root, 'leaf-a.spec.js'), spec(['a-one', 'a-two']));
  fs.writeFileSync(path.join(root, 'leaf-b.spec.js'), spec(['b-one', 'b-two']));
  return root;
}

/** Runs `playwright test` with the reporter: `{ status, output, record }`. */
function playwright(args, { mode = 'native', reporter = true, env = {} } = {}) {
  const record = path.join(tempDir('psp-invocation-record-'), 'record.json');
  const result = spawnSync(
    process.execPath,
    [
      path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      ...args,
      ...(reporter ? [`--add-reporter=${REPORTER}`] : []),
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PSP_MODE: mode,
        PSP_KEY: KEY,
        PSP_RECORD: record,
        PSP_RUN_ID: '7',
        ...(mode === 'balanced'
          ? { PSP_SNAPSHOT: snapshot.file, PSP_SNAPSHOT_SHA: snapshot.sha }
          : {}),
        ...env,
      },
    }
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    record: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null,
  };
}

const shards = (total, args, options) =>
  Array.from({ length: total }, (_, i) =>
    playwright([`--shard=${i + 1}/${total}`, ...args], options)
  );

const titleOf = (t) => JSON.parse(t.key).at(-1);
const corpusTitles = (record) => record.corpus.map(([, label]) => label.split(' › ').at(-1)).sort();
const ran = (record) => record.tests.map(titleOf).sort();

const ALL = ['a-one', 'a-two', 'b-one', 'b-two', 'cleanup-one', 'setup-one', 'setup-two'];
const LEAVES = ['a-one', 'a-two', 'b-one', 'b-two'];

before(() => {
  requireFixture();
  dir = writeProject();
  const history = emptyHistory(KEY);
  for (const [file, title, ms] of [
    ['leaf-a.spec.js', 'a-one', 4000],
    ['leaf-b.spec.js', 'b-one', 1000],
  ]) {
    history.tests[testKey('leaf', file, [title])] = { samples: [[1, ms]], seen: '2026-10-16' };
  }
  snapshot = writeSnapshot(history);
});

describe('--no-deps: setup, teardown and leaf projects are ordinary projects', () => {
  const forms = {
    'no --project': ['--no-deps'],
    'three --project flags': [
      '--project=setup',
      '--project=cleanup',
      '--project=leaf',
      '--no-deps',
    ],
    'one --project with three names': ['--no-deps', '--project', 'setup', 'cleanup', 'leaf'],
  };
  for (const mode of ['native', 'balanced']) {
    for (const [form, args] of Object.entries(forms)) {
      test(`${mode}, ${form}: every selected test is in the corpus and runs once`, () => {
        const run = shards(2, args, { mode });
        assert.deepStrictEqual(
          run.map((s) => s.status),
          [0, 0],
          run.map((s) => s.output).join('\n')
        );
        const records = run.map((s) => s.record);
        for (const record of records) {
          assert.deepStrictEqual(corpusTitles(record), ALL);
          assert.ok(record.tests.every((t) => t.setup === false));
          assert.deepStrictEqual(record.phases, {});
        }
        assert.deepStrictEqual(records.flatMap(ran).sort(), ALL, 'each test ran exactly once');
        if (mode === 'balanced') assert.ok(records.every((r) => r.planSha === records[0].planSha));
        const result = checkRun({ total: 2, runId: 7 }, records);
        assert.deepStrictEqual(result.problems, []);
        assert.strictEqual(result.ok, true);
      });
    }
  }

  test('a test that ran in two shards still fails the check', () => {
    const records = shards(2, ['--no-deps'], { mode: 'native' }).map((s) => s.record);
    records[1].tests.push(records[0].tests.find((t) => titleOf(t) === 'setup-one'));
    const result = checkRun({ total: 2, runId: 7 }, records);
    assert.strictEqual(result.ok, false);
    assert.ok(result.problems.some((p) => /1 test\(s\) ran in more than one shard/.test(p)));
  });

  test('--no-deps as the value of -G keeps the dependencies', () => {
    const run = shards(2, ['-G', '--no-deps'], { mode: 'native' });
    assert.ok(run.every((s) => s.record.tests.some((t) => t.setup)));
    assert.ok(run.every((s) => corpusTitles(s.record).join() === LEAVES.join()));
  });
});

describe('dependencies on: setup runs on every shard that needs it', () => {
  for (const mode of ['native', 'balanced']) {
    test(`${mode}: the corpus holds the leaves, setup and teardown run on each leaf shard`, () => {
      const run = shards(2, [], { mode });
      assert.deepStrictEqual(
        run.map((s) => s.status),
        [0, 0]
      );
      const records = run.map((s) => s.record);
      for (const record of records) {
        assert.deepStrictEqual(corpusTitles(record), LEAVES);
        assert.deepStrictEqual(Object.keys(record.phases).sort(), ['cleanup', 'setup']);
        const setup = record.tests
          .filter((t) => t.setup)
          .map(titleOf)
          .sort();
        assert.deepStrictEqual(setup, ['cleanup-one', 'setup-one', 'setup-two']);
      }
      const leaves = records.flatMap((r) => r.tests.filter((t) => !t.setup).map(titleOf));
      assert.deepStrictEqual(leaves.sort(), LEAVES);
      assert.strictEqual(checkRun({ total: 2, runId: 7 }, records).ok, true);
    });
  }
});

describe('--last-failed stops every shard before any test', () => {
  let lastRun;
  before(() => {
    const first = playwright(['--project=leaf'], { env: { FAIL: 'a-one' } });
    assert.strictEqual(first.status, 1);
    lastRun = fs.readFileSync(path.join(dir, 'test-results', '.last-run.json'), 'utf8');
  });
  const restore = () => {
    fs.mkdirSync(path.join(dir, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-results', '.last-run.json'), lastRun);
  };

  for (const mode of ['native', 'balanced']) {
    test(`${mode}: both shards exit 1 with no test run and the check fails`, () => {
      const run = [1, 2].map((i) => {
        restore();
        return playwright([`--shard=${i}/2`, '--project=leaf', '--last-failed'], { mode });
      });
      for (const shard of run) {
        assert.strictEqual(shard.status, 1);
        assert.match(shard.output, /--last-failed is not supported/);
        assert.match(shard.output, /enabled: false/);
        assert.deepStrictEqual(shard.record.tests, []);
        assert.strictEqual(shard.record.corpus, null);
      }
      assert.strictEqual(
        checkRun(
          { total: 2, runId: 7 },
          run.map((s) => s.record)
        ).ok,
        false
      );
    });
  }

  test('an override of the last-run file and an empty last-failed list are refused alike', () => {
    const file = path.join(tempDir('psp-last-run-'), 'last.json');
    fs.writeFileSync(file, JSON.stringify({ status: 'passed', failedTests: [] }));
    const run = playwright(['--shard=1/2', `--last-failed-file=${file}`, '--last-failed']);
    assert.strictEqual(run.status, 1);
    assert.match(run.output, /--last-failed is not supported/);
  });

  test('with the Action disabled the command is plain Playwright and runs the last failure', () => {
    const run = [1, 2].map((i) => {
      restore();
      return playwright([`--shard=${i}/2`, '--project=leaf', '--last-failed', '--reporter=list'], {
        reporter: false,
      });
    });
    assert.deepStrictEqual(
      run.map((s) => s.status),
      [0, 0]
    );
    const executed = run.map((s) => s.output).join('\n');
    assert.match(executed, /a-one/);
    assert.doesNotMatch(executed, /a-two|b-one|b-two/);
  });
});
