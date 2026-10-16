/** Tests for scratch directories, project copies and the fixture variants. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { median, directoryBytes, size } = require('../measure');
const { copyProject, tempDir, writeJson } = require('../project');
const variants = require('../variants');

const dirs = [];
function scratch() {
  const dir = tempDir('lib-test');
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function source() {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'tests', 'b.js'), 'b');
  return dir;
}

describe('tempDir', () => {
  test('creates a directory under the system temp directory named for the prefix', () => {
    const dir = scratch();
    assert.ok(
      dir.startsWith(os.tmpdir()) || fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()))
    );
    assert.match(path.basename(dir), /^psp-lib-test-/);
  });
});

describe('copyProject', () => {
  test('copies the project without node_modules, links it and applies edits', () => {
    const copy = copyProject(source(), scratch(), { 'tests/b.js': null, 'tests/c.js': 'c' });
    assert.deepStrictEqual(fs.readdirSync(path.join(copy, 'tests')).sort(), ['a.js', 'c.js']);
    assert.ok(fs.lstatSync(path.join(copy, 'node_modules')).isSymbolicLink());
  });

  test('is not a git repository unless asked', () => {
    const copy = copyProject(source(), scratch());
    assert.notStrictEqual(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: copy }).status, 0);
  });

  test('becomes a one-commit repository holding every file but node_modules on request', () => {
    const copy = copyProject(source(), scratch(), { 'tests/c.js': 'c' }, { git: true });
    const commits = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: copy,
      encoding: 'utf8',
    });
    assert.strictEqual(commits.stdout.trim(), '1');
    const files = spawnSync('git', ['ls-files'], { cwd: copy, encoding: 'utf8' }).stdout.split(
      '\n'
    );
    assert.deepStrictEqual(files.filter(Boolean).sort(), [
      '.gitignore',
      'tests/a.js',
      'tests/b.js',
      'tests/c.js',
    ]);
  });
});

describe('writeJson', () => {
  test('writes the value and returns the path', () => {
    const file = path.join(scratch(), 'x.json');
    assert.strictEqual(writeJson(file, { a: 1 }), file);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  });
});

describe('measure', () => {
  test('median takes the middle of the sorted values', () => {
    assert.strictEqual(median([5, 1, 3]), 3);
    assert.strictEqual(median([4, 1, 100, 2, 3]), 3);
  });

  test('directoryBytes adds up the files below a directory', () => {
    const dir = source();
    assert.strictEqual(directoryBytes(dir), 2);
    assert.strictEqual(size(path.join(dir, 'tests', 'a.js')), 1);
  });
});

describe('fixture variants', () => {
  const edits = [];
  const ctx = {
    cwd: path.resolve(__dirname, '..', '..', '..', 'fixtures', 'consumer'),
    once: (key, build) => build(),
    copy: (name, files) => {
      edits.push([name, files]);
      return name;
    },
  };

  test('the passing and failing volatile tests take their durations from the environment', () => {
    variants.greenProject(ctx);
    variants.redProject(ctx);
    const green = edits.find(([name]) => name === 'variant-green')[1]['tests/volatile.spec.js'];
    const red = edits.find(([name]) => name === 'variant-red')[1]['tests/volatile.spec.js'];
    assert.match(green, /process\.env\.PSP_VOLATILE_MS \|\| 1000/);
    assert.match(green, /PSP_VOLATILE_FIREFOX_EXTRA_MS/);
    assert.match(red, /process\.env\.PSP_FAIL_AFTER_MS \|\| 0/);
  });

  test('the mixed variant has one project that needs setup and one that does not', () => {
    variants.mixedProject(ctx);
    const config = edits.find(([name]) => name === 'variant-mixed')[1]['playwright.config.js'];
    assert.match(config, /name: 'chromium'.*dependencies: \['setup'\]/);
    assert.match(config, /name: 'api'(?!.*dependencies)/);
  });

  test('the spec-only variants delete every other spec of the fixture', () => {
    variants.prefixProject(ctx);
    const files = edits.find(([name]) => name === 'variant-prefix')[1];
    assert.ok(files['tests/prefix.spec.js']);
    assert.strictEqual(files['tests/cart.spec.js'], null);
    assert.strictEqual(files['tests/support.js'], undefined);
  });
});
