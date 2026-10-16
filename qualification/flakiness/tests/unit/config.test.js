/** Tests for the Playwright config every Flakiness run loads. */

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configFor } = require('../../config');
const { reporterPath } = require('../../engine');

const KEYS = [
  'PSP_FLK_TIMINGS',
  'PSP_FLK_PLAIN',
  'PSP_FLK_UPLOAD',
  'PSP_FLK_EXTRA',
  'PSP_FLK_REPORTER',
];
let project;

before(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-config-test-'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.js'),
    "module.exports = { testDir: './tests', retries: 2, projects: [{ name: 'one' }] };\n"
  );
});
after(() => fs.rmSync(project, { recursive: true, force: true }));
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

const flakiness = (config) =>
  config.reporter.find(([name]) => name !== 'list' && name.endsWith('.js'));

describe('configFor', () => {
  test('keeps the project config and makes its test directory absolute', () => {
    const config = configFor({ project });
    assert.strictEqual(config.testDir, path.join(project, 'tests'));
    assert.strictEqual(config.retries, 2);
    assert.deepStrictEqual(config.projects, [{ name: 'one' }]);
    assert.strictEqual(config.fullyParallel, undefined);
  });

  test('adds the installed reporter with the upload disabled and no timings file', () => {
    const [name, options] = flakiness(configFor({ project }));
    assert.strictEqual(name, reporterPath());
    assert.deepStrictEqual(options, { disableUpload: true });
  });

  test('balances from the timings file in PSP_FLK_TIMINGS', () => {
    process.env.PSP_FLK_TIMINGS = '/t/timings.json';
    const [, options] = flakiness(configFor({ project }));
    assert.deepStrictEqual(options, {
      disableUpload: true,
      shardBalancing: { timingsFile: '/t/timings.json' },
    });
  });

  test('leaves the reporter out for a plain run', () => {
    process.env.PSP_FLK_PLAIN = '1';
    process.env.PSP_FLK_TIMINGS = '/t/timings.json';
    assert.deepStrictEqual(configFor({ project }).reporter, [['list']]);
  });

  test('leaves disableUpload off only when asked', () => {
    process.env.PSP_FLK_UPLOAD = '1';
    assert.strictEqual(flakiness(configFor({ project }))[1].disableUpload, false);
  });

  test('adds the named Playwright reporters before the Flakiness reporter', () => {
    process.env.PSP_FLK_EXTRA = 'json,blob';
    const names = configFor({ project }).reporter.map(([name]) => name);
    assert.deepStrictEqual(names.slice(0, 3), ['list', 'json', 'blob']);
    assert.strictEqual(names[3], reporterPath());
  });

  test('loads a different reporter file when PSP_FLK_REPORTER names one', () => {
    process.env.PSP_FLK_REPORTER = '/copy/playwright-test.js';
    assert.strictEqual(flakiness(configFor({ project }))[0], '/copy/playwright-test.js');
  });

  test('turns fullyParallel on only when asked', () => {
    assert.strictEqual(configFor({ project, fullyParallel: true }).fullyParallel, true);
    assert.strictEqual('fullyParallel' in configFor({ project }), false);
  });
});
