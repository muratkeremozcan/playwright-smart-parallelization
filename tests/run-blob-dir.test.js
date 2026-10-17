/**
 * Where disabled mode uploads the blob report from: the folder the user's own blob reporter writes
 * to, since rollback adds no reporter of the Action's.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { userBlobDir } = require('../lib/run');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-blobdir-'));
fs.mkdirSync(path.join(cwd, 'e2e'));

test('defaults to blob-report in the working directory', () => {
  assert.strictEqual(userBlobDir('npx playwright test', cwd, {}), path.join(cwd, 'blob-report'));
});

test('follows the config the command names, as a file or a folder, in every spelling', () => {
  const beside = path.join(cwd, 'e2e', 'blob-report');
  for (const command of [
    'npx playwright test --config e2e/playwright.config.ts',
    'npx playwright test --config=e2e/playwright.config.ts',
    'npx playwright test -c e2e/playwright.config.ts',
    'npx playwright test -ce2e/playwright.config.ts',
    'npx playwright test -c e2e',
  ]) {
    assert.strictEqual(userBlobDir(command, cwd, {}), beside, command);
  }
});

test('follows the blob output the job environment sets, the file before the folder', () => {
  assert.strictEqual(
    userBlobDir('npx playwright test', cwd, { PLAYWRIGHT_BLOB_OUTPUT_DIR: 'out/blobs' }),
    path.join(cwd, 'out', 'blobs')
  );
  assert.strictEqual(
    userBlobDir('npx playwright test -c e2e', cwd, {
      PLAYWRIGHT_BLOB_OUTPUT_DIR: 'out/blobs',
      PLAYWRIGHT_BLOB_OUTPUT_FILE: 'files/report.zip',
    }),
    path.join(cwd, 'files')
  );
});
