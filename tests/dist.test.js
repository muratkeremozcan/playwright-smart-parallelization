/**
 * `dist/` is the output of scripts/build.js: a fresh build equals the committed files, so the
 * Action users run is the code in this repository. The reporter bundle loads on its own.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../scripts/build');

const ROOT = path.join(__dirname, '..');

test('dist/ is the output of scripts/build.js', async () => {
  const out = await build(fs.mkdtempSync(path.join(os.tmpdir(), 'psp-dist-')));
  const names = fs.readdirSync(out).sort();
  assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'dist')).sort(), names);
  for (const name of names) {
    assert.ok(
      fs.readFileSync(path.join(out, name)).equals(fs.readFileSync(path.join(ROOT, 'dist', name))),
      `dist/${name} differs from a fresh build: run \`npm run build\``
    );
  }
});

test('the bundled reporter loads with no node_modules beside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-reporter-'));
  fs.copyFileSync(path.join(ROOT, 'dist', 'reporter.js'), path.join(dir, 'reporter.js'));
  const Reporter = require(path.join(dir, 'reporter.js'));
  assert.strictEqual(typeof Reporter, 'function');
  assert.strictEqual(typeof Reporter.prototype.preprocess, 'function');
});
