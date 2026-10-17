/**
 * The blob report of a shard when the user's config already has a blob reporter: the Action adds
 * its own (the command names none), both write the one file the Action names, and the second
 * write replaces the first whole. Each shard ends with one valid zip, and the zips merge.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { shardArgv } = require('../lib/command');
const { blobOutput } = require('../lib/run');
const { FIXTURE, requireFixture } = require('./support/fixture');

const COMMAND =
  'npx playwright test --config=blob.config.js --project=chromium --grep-invert=oversized';

test('a blob reporter in the config lands in the Action folder: one valid zip per shard, and they merge', () => {
  requireFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-blob-'));
  const merged = path.join(root, 'all');
  fs.mkdirSync(merged);
  for (const shard of [1, 2]) {
    const argv = shardArgv(COMMAND, { shard, total: 2 });
    assert.strictEqual(argv[argv.length - 1], '--add-reporter=blob', 'the command names none');
    const dir = path.join(root, `shard-${shard}`);
    const result = spawnSync('bash', ['-c', 'exec "$@"', 'bash', ...argv], {
      cwd: FIXTURE,
      encoding: 'utf8',
      env: { ...process.env, ...blobOutput(dir, shard) },
    });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepStrictEqual(fs.readdirSync(dir), [`report-${shard}.zip`]);
    const zip = path.join(dir, `report-${shard}.zip`);
    const check = spawnSync('unzip', ['-tq', zip], { encoding: 'utf8' });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    fs.copyFileSync(zip, path.join(merged, `report-${shard}.zip`));
  }
  assert.ok(!fs.existsSync(path.join(FIXTURE, 'blob-report')), 'nothing outside the Action folder');
  const cli = require.resolve('@playwright/test/cli', { paths: [FIXTURE] });
  const html = path.join(root, 'html');
  const merge = spawnSync(process.execPath, [cli, 'merge-reports', '--reporter=html', merged], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_HTML_OUTPUT_DIR: html, PLAYWRIGHT_HTML_OPEN: 'never' },
  });
  assert.strictEqual(merge.status, 0, merge.stdout + merge.stderr);
  assert.ok(fs.existsSync(path.join(html, 'index.html')));
});
