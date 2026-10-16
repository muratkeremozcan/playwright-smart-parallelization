/** Tests for the list, partition and report helpers that connect the engine to the harness. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const drive = require('../../drive');

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-drive-test-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const tests = (...names) => names.map((projectName) => ({ projectName }));

const json = {
  config: { projects: [] },
  suites: [
    {
      title: 'a.spec.js',
      specs: [
        { title: 'both', tests: tests('chromium', 'firefox') },
        { title: 'firefox only', tests: tests('firefox') },
      ],
      suites: [
        {
          title: 'nested',
          specs: [{ title: 'deep', tests: tests('chromium', 'setup') }],
        },
      ],
    },
  ],
};

describe('filterProjects', () => {
  const titles = (list) => {
    const found = [];
    const visit = (suite) => {
      for (const spec of suite.specs)
        found.push([spec.title, spec.tests.map((t) => t.projectName)]);
      suite.suites.forEach(visit);
    };
    list.suites.forEach(visit);
    return found;
  };

  test('keeps the tests of the wanted projects in specs and nested suites', () => {
    assert.deepStrictEqual(titles(drive.filterProjects(json, ['chromium'])), [
      ['both', ['chromium']],
      ['deep', ['chromium']],
    ]);
  });

  test('keeps dependency projects when asked', () => {
    const kept = titles(drive.filterProjects(json, ['chromium', 'setup']));
    assert.deepStrictEqual(kept.at(-1), ['deep', ['chromium', 'setup']]);
  });

  test('does not change its input', () => {
    drive.filterProjects(json, ['chromium']);
    assert.strictEqual(json.suites[0].specs.length, 2);
  });
});

describe('assignmentLines', () => {
  const assignment = { testListFiles: { 1: 'a.spec.js › one\nb.spec.js › two\n', 2: '' } };

  test('returns the lines of a shard', () => {
    assert.deepStrictEqual(drive.assignmentLines(assignment, 1), [
      'a.spec.js › one',
      'b.spec.js › two',
    ]);
  });

  test('prefixes every line with the project', () => {
    assert.deepStrictEqual(drive.assignmentLines(assignment, 1, 'firefox'), [
      '[firefox] › a.spec.js › one',
      '[firefox] › b.spec.js › two',
    ]);
  });

  test('returns nothing for an empty or absent shard', () => {
    assert.deepStrictEqual(drive.assignmentLines(assignment, 2), []);
    assert.deepStrictEqual(drive.assignmentLines(assignment, 3), []);
  });
});

describe('partitionOf', () => {
  const result = (lines) => ({ assignment: { testListFiles: lines } });
  const assignments = {
    chromium: result({ 1: 'a › one\n', 2: 'a › two\n' }),
    firefox: result({ 1: 'a › two\n', 2: 'a › one\n' }),
  };

  test('combined writes the verbatim lines of the one assignment per shard', () => {
    const dir = tempDir();
    const partition = drive.partitionOf(
      'combined',
      { all: result({ 1: 'a › one\n', 2: 'a › two\n' }) },
      2,
      dir
    );
    assert.strictEqual(partition.length, 2);
    assert.strictEqual(fs.readFileSync(partition[1].args[1], 'utf8'), 'a › two\n');
    assert.strictEqual(partition[1].args[0], '--test-list');
  });

  test('jobs makes one job per project and shard, each selecting its project', () => {
    const partition = drive.partitionOf('jobs', assignments, 2, tempDir());
    assert.deepStrictEqual(
      partition.map((job) => job.args.at(-1)),
      ['--project=chromium', '--project=chromium', '--project=firefox', '--project=firefox']
    );
    assert.strictEqual(fs.readFileSync(partition[2].args[1], 'utf8'), 'a › two\n');
  });

  test('merged puts both projects, prefixed, into the list of each shard', () => {
    const partition = drive.partitionOf('merged', assignments, 2, tempDir());
    assert.strictEqual(partition.length, 2);
    assert.strictEqual(
      fs.readFileSync(partition[0].args[1], 'utf8'),
      '[chromium] › a › one\n[firefox] › a › two\n'
    );
  });

  test('grouped writes the lines of its one assignment verbatim, like combined', () => {
    const lines = { 1: '[chromium] › a › one\n', 2: '[firefox] › a › two\n' };
    const partition = drive.partitionOf('grouped', { all: result(lines) }, 2, tempDir());
    assert.deepStrictEqual(
      partition.map((shard) => fs.readFileSync(shard.args[1], 'utf8')),
      ['[chromium] › a › one\n', '[firefox] › a › two\n']
    );
  });
});

describe('withReports', () => {
  test('adds a JSON report path and reporter to each shard and keeps its own env', () => {
    const dir = tempDir();
    const shards = drive.withReports([{ args: ['--shard=1/2'], env: { KEEP: '1' } }], dir);
    assert.deepStrictEqual(shards[0].args, ['--shard=1/2', '--reporter=json']);
    assert.strictEqual(shards[0].env.KEEP, '1');
    assert.strictEqual(shards[0].env.PLAYWRIGHT_JSON_OUTPUT_FILE, path.join(dir, 'report-1.json'));
  });

  test('blob and output options add a blob directory and a results directory per shard', () => {
    const dir = tempDir();
    const [, second] = drive.withReports([{ args: [] }, { args: [] }], dir, {
      blob: true,
      output: true,
    });
    assert.deepStrictEqual(second.args, [
      '--reporter=json,blob',
      `--output=${path.join(dir, 'results-2')}`,
    ]);
    assert.strictEqual(second.env.PLAYWRIGHT_BLOB_OUTPUT_DIR, path.join(dir, 'blob-2'));
  });

  test('reportFiles lists only the reports that exist', () => {
    const dir = tempDir();
    const shards = drive.withReports([{ args: [] }, { args: [] }], dir);
    fs.writeFileSync(shards[1].env.PLAYWRIGHT_JSON_OUTPUT_FILE, '{}');
    assert.deepStrictEqual(drive.reportFiles(shards), [shards[1].env.PLAYWRIGHT_JSON_OUTPUT_FILE]);
  });
});

describe('copyProject', () => {
  test('copies the project without node_modules, links it and applies edits', () => {
    const source = tempDir();
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.mkdirSync(path.join(source, 'tests'));
    fs.writeFileSync(path.join(source, 'tests', 'a.js'), 'a');
    fs.writeFileSync(path.join(source, 'tests', 'b.js'), 'b');
    const copy = drive.copyProject(source, tempDir(), { 'tests/b.js': null, 'tests/c.js': 'c' });
    assert.strictEqual(fs.readFileSync(path.join(copy, 'tests', 'a.js'), 'utf8'), 'a');
    assert.ok(!fs.existsSync(path.join(copy, 'tests', 'b.js')));
    assert.strictEqual(fs.readFileSync(path.join(copy, 'tests', 'c.js'), 'utf8'), 'c');
    assert.ok(fs.lstatSync(path.join(copy, 'node_modules')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(source, 'tests', 'b.js')), 'the source is untouched');
  });
});

describe('violationKinds and primaryProjects', () => {
  test('violationKinds counts by kind', () => {
    const report = { violations: [{ kind: 'a' }, { kind: 'b' }, { kind: 'a' }] };
    assert.deepStrictEqual(drive.violationKinds(report), { a: 2, b: 1 });
  });

  test('primaryProjects lists projects of non-dependency leaves in order, once each', () => {
    const leaf = (project, dependency = false) => ({ project, dependency });
    const listing = {
      leaves: [
        leaf('setup', true),
        leaf('chromium'),
        leaf('firefox'),
        leaf('chromium'),
        leaf('teardown', true),
      ],
    };
    assert.deepStrictEqual(drive.primaryProjects(listing), ['chromium', 'firefox']);
  });
});
