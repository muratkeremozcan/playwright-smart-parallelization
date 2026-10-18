/**
 * Tests for the public interface: `action.yml`, a JavaScript action whose main step runs before
 * the user's Playwright step and whose post step runs after every step, and `finish/action.yml`,
 * the optional finish action, both running the bundle in `dist/`. The Action's code reads no
 * private field of Playwright.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ACTION_INPUTS, FINISH_INPUTS } = require('../lib/inputs');

const ROOT = path.join(__dirname, '..');
const read = (file) => YAML.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const action = read('action.yml');
const finish = read('finish/action.yml');

describe('action.yml', () => {
  test('declares the inputs the main step reads, every one optional with a default', () => {
    assert.deepStrictEqual(
      Object.keys(action.inputs).sort(),
      [...ACTION_INPUTS, 'github-token'].sort()
    );
    assert.strictEqual(action.inputs['github-token'].default, '${{ github.token }}');
    for (const [name, input] of Object.entries(action.inputs)) {
      assert.strictEqual(input.required, false, name);
      assert.strictEqual(typeof input.default, 'string', name);
    }
    assert.strictEqual(action.inputs['publish-history'].default, 'auto');
    // Playwright owns the workers, the runner context names the runner, and an if: on the step
    // skips it, so none of them is an input.
    for (const derived of ['workers', 'runner-label', 'enabled']) {
      assert.strictEqual(action.inputs[derived], undefined, derived);
    }
  });

  test('outputs the mode, its reason and the arguments', () => {
    assert.deepStrictEqual(Object.keys(action.outputs).sort(), ['args', 'mode', 'reason']);
  });

  test('runs the bundle on node24 with a post step that runs whatever the job did', () => {
    assert.deepStrictEqual(action.runs, {
      using: 'node24',
      main: 'dist/main.js',
      post: 'dist/post.js',
      'post-if': 'always()',
    });
    for (const file of ['dist/main.js', 'dist/post.js', 'dist/index.js', 'dist/reporter.js']) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    }
  });
});

describe('finish/action.yml', () => {
  test('takes the history key to scope to and the token, and runs the same bundle', () => {
    assert.deepStrictEqual(Object.keys(finish.inputs).sort(), [...FINISH_INPUTS].sort());
    assert.strictEqual(finish.inputs['github-token'].default, '${{ github.token }}');
    assert.deepStrictEqual(Object.keys(finish.outputs).sort(), [
      'exactly-once',
      'mode',
      'overhead-ms',
    ]);
    assert.deepStrictEqual(finish.runs, { using: 'node24', main: 'main.js' });
    assert.match(
      fs.readFileSync(path.join(ROOT, 'finish', 'main.js'), 'utf8'),
      /require\('\.\.\/dist\/index\.js'\)\.run\('finish'\)/
    );
  });
});

describe('Marketplace metadata', () => {
  test('has the name, a description the listing shows whole, and branding', () => {
    assert.strictEqual(action.name, 'Playwright Smart Parallelization');
    for (const a of [action, finish]) {
      assert.ok(a.description.length <= 125, 'the Marketplace cuts descriptions at 125');
      assert.match(a.branding.icon, /^[a-z0-9-]+$/);
      assert.ok(
        [
          'white',
          'black',
          'yellow',
          'blue',
          'green',
          'orange',
          'red',
          'purple',
          'gray-dark',
        ].includes(a.branding.color)
      );
    }
  });
});

test('the Action reads no private field of Playwright', () => {
  const files = ['lib', 'lib/plan', 'reporter', 'src'].flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `${dir}/${f}`)
  );
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /\._[A-Za-z]\w*/, `${file} reads a private field`);
  }
});
