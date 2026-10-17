/**
 * The blob report of a disabled shard. The Action adds no reporter there; its blob variables point
 * a blob reporter of the user's config at the Action's folder, and when the Playwright of the run
 * ignored them, the report is copied from Playwright's default folder.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const run = require('../lib/run');
const prepare = require('../lib/prepare');
const { readInputs } = require('../lib/inputs');
const { FIXTURE } = require('./support/fixture');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('the default folder is blob-report at the nearest package root of the config, else the working directory', () => {
  const cwd = tmp('psp-blobdir-');
  fs.mkdirSync(path.join(cwd, 'e2e', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  const root = path.join(cwd, 'blob-report');
  for (const command of [
    'npx playwright test',
    'npx playwright test --config e2e/nested/playwright.config.ts',
    'npx playwright test --config=e2e/nested/playwright.config.ts',
    'npx playwright test -c e2e/nested',
    'npx playwright test -ce2e/nested/playwright.config.ts',
  ]) {
    assert.strictEqual(run.defaultBlobDir(command, cwd), root, command);
  }
  fs.writeFileSync(path.join(cwd, 'e2e', 'package.json'), '{}');
  assert.strictEqual(
    run.defaultBlobDir('npx playwright test -c e2e/nested', cwd),
    path.join(cwd, 'e2e', 'blob-report')
  );
});

test('a disabled shard whose Playwright ignored the blob variables still hands over its blob report', () => {
  const ws = tmp('psp-blobws-');
  const app = path.join(ws, 'app');
  fs.mkdirSync(app);
  fs.copyFileSync(path.join(FIXTURE, 'package-lock.json'), path.join(app, 'package-lock.json'));
  fs.writeFileSync(path.join(app, 'package.json'), '{}');
  const env = {
    GITHUB_WORKSPACE: ws,
    RUNNER_TEMP: tmp('psp-blobtemp-'),
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'c0ffee',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
  };
  const inputs = {
    ...readInputs({}),
    phase: 'prepare',
    shards: '2',
    command: 'npx playwright test',
    'working-directory': 'app',
    enabled: 'false',
  };
  const plan = prepare.plan({ inputs, env }).outputs.plan;
  const setup = run.setup({ inputs: { plan, shard: '1' }, env });
  // A stand-in `npx` that, like an old Playwright, writes to the default folder whatever the
  // variables say.
  const bin = tmp('psp-blobbin-');
  fs.writeFileSync(
    path.join(bin, 'npx'),
    "#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.mkdirSync('blob-report', { recursive: true });\nfs.writeFileSync('blob-report/report-1.zip', 'zip');\n",
    { mode: 0o755 }
  );
  const status = run.exec({
    inputs: { plan, shard: '1' },
    env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: 'ignore',
  });
  assert.strictEqual(status, 0);
  assert.deepStrictEqual(fs.readdirSync(setup.outputs['blob-path']), ['report-1.zip']);
});
