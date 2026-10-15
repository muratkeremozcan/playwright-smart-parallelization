/**
 * Tests for the public-repo hygiene gate. Fixtures are assembled from pieces so this file does not
 * trip the gate it tests.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gate = require('../scripts/check-public.js');

const slash = '/';
const macHome = `${slash}Users${slash}someone${slash}project`;
const linuxHome = `${slash}home${slash}someone${slash}project`;
const winHome = ['C:', 'Users', 'someone', 'project'].join('\\');
const githubToken = `${'gh'}p_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const awsKey = `${'AKIA'}${'ABCDEFGHIJKLMNOP'}`;
const anthropicKey = `${'sk-'}ant-${'api03-abcdefghijklmnopqrstuvwxyz'}`;
const slackToken = `${'xo'}xb-${'1234567890-abcdefghij'}`;
const privateKey = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;

describe('scanText', () => {
  const flagged = [
    ['macOS home path', `cd ${macHome}`, 'private macOS home path'],
    ['Linux home path', `cd ${linuxHome}`, 'private Linux home path'],
    ['Windows home path', `cd ${winHome}`, 'private Windows home path'],
    ['GitHub token', `token: ${githubToken}`, 'GitHub token'],
    ['AWS access key', `key=${awsKey}`, 'AWS access key id'],
    ['Anthropic API key', `key: ${anthropicKey}`, 'Anthropic API key'],
    ['Slack token', `token ${slackToken}`, 'Slack token'],
    ['private key block', privateKey, 'private key block'],
  ];

  for (const [label, text, rule] of flagged) {
    test(`flags a ${label} with file and line`, () => {
      assert.deepStrictEqual(gate.scanText(`first\n${text}\n`, 'a.md'), [
        { file: 'a.md', line: 2, rule },
      ]);
    });
  }

  test('flags a JSON-escaped Windows home path', () => {
    const escaped = ['C:', 'Users', 'someone'].join('\\\\');
    assert.deepStrictEqual(gate.scanText(`{"p": "${escaped}"}`, 'a.json'), [
      { file: 'a.json', line: 1, rule: 'private Windows home path' },
    ]);
  });

  test('flags home paths of accounts whose name only starts with runner', () => {
    for (const text of [
      `${slash}home${slash}runner-private${slash}x`,
      `${slash}Users${slash}runner-private`,
      `${slash}home${slash}runner2`,
    ]) {
      assert.strictEqual(gate.scanText(text, 'a.md').length, 1, text);
    }
  });

  test('allows public runner paths, tilde paths and plain prose', () => {
    const clean = [
      `${slash}home${slash}runner${slash}work`,
      `${slash}Users${slash}runner${slash}work`,
      `${slash}home${slash}runner`,
      '~/opensource/couture-cast',
      'Users and home directories are fine as words',
    ].join('\n');
    assert.deepStrictEqual(gate.scanText(clean, 'a.md'), []);
  });
});

describe('check:public as a process', () => {
  const dirs = [];
  after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  function gitRepoWith(file, content, { track = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-public-'));
    dirs.push(dir);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, file), content);
    if (track) spawnSync('git', ['add', file], { cwd: dir });
    return dir;
  }

  const script = path.join(__dirname, '..', 'scripts', 'check-public.js');

  test('exits 1, names file:line and never echoes the secret', () => {
    const dir = gitRepoWith('notes.md', `ok\ntoken ${githubToken}\n`);
    const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /notes\.md:2: GitHub token/);
    assert.ok(!result.stderr.includes(githubToken));
  });

  test('scans tracked files, which is what CI sees on a clean checkout', () => {
    const leak = gitRepoWith('notes.md', `cd ${macHome}\n`, { track: true });
    const leakResult = spawnSync(process.execPath, [script], { cwd: leak, encoding: 'utf8' });
    assert.strictEqual(leakResult.status, 1);
    assert.match(leakResult.stderr, /notes\.md:1: private macOS home path/);

    const clean = gitRepoWith('notes.md', 'nothing private here\n', { track: true });
    const cleanResult = spawnSync(process.execPath, [script], { cwd: clean, encoding: 'utf8' });
    assert.strictEqual(cleanResult.status, 0);
    assert.match(cleanResult.stdout, /scanned 1 files, no findings/);
  });

  test('exits 0 on a clean tree', () => {
    const dir = gitRepoWith('notes.md', 'nothing private here\n');
    const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
  });

  test('scans UTF-16 files in both byte orders instead of skipping them as binary', () => {
    const text = `cd ${macHome}\n`;
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const be = Buffer.from(le.subarray(2)).swap16();
    for (const [name, content] of [
      ['le.txt', le],
      ['be.txt', be],
    ]) {
      const dir = gitRepoWith(name, content, { track: true });
      const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
      assert.strictEqual(result.status, 1, name);
      assert.match(result.stderr, new RegExp(`${name}:1: private macOS home path`));
    }
  });

  test('ignored files are not scanned', () => {
    const dir = gitRepoWith('.gitignore', 'local.md\n');
    fs.writeFileSync(path.join(dir, 'local.md'), `cd ${macHome}\n`);
    const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
  });
});

describe('this repository', () => {
  test('has no findings in any tracked or unignored file', () => {
    const root = path.join(__dirname, '..');
    const files = gate.listFiles(root);
    assert.ok(files.includes('main.js'), 'the scan must see this repository files');
    const findings = gate.scanFiles(files, root);
    assert.deepStrictEqual(findings, []);
  });
});
