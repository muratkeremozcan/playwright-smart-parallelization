/** Tests for the network guard preload: it must record and refuse every kind of attempt. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GUARD, attemptsIn, guardEnv, readLog } = require('../netcheck');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-guard-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function guarded(script, name) {
  const log = path.join(dir, `${name}.log`);
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...guardEnv(log) },
  });
  return { result, entries: readLog(log) };
}

describe('net-guard', () => {
  test('is the file the scenarios preload', () => {
    assert.ok(fs.existsSync(GUARD));
  });

  for (const [name, script, kind] of [
    ['net.connect', "require('node:net').connect(80, 'vendor.invalid')", 'connect'],
    ['a port number', "require('node:net').connect(8080)", 'connect'],
    ['dns.lookup', "require('node:dns').lookup('vendor.invalid', () => {})", 'dns.lookup'],
    [
      'dns.promises',
      "require('node:dns').promises.resolve4('vendor.invalid').catch(() => {})",
      'dns.promises.resolve4',
    ],
    ['fetch', "fetch('https://vendor.invalid/x').catch(() => {})", 'fetch'],
    [
      'https.get',
      "require('node:https').get('https://vendor.invalid/').on('error', () => {})",
      'connect',
    ],
  ]) {
    test(`records and refuses ${name}`, () => {
      const { entries } = guarded(script, name.replace(/\W/g, '-'));
      const kinds = attemptsIn(entries).map((entry) => entry.kind);
      assert.ok(kinds.includes(kind), `expected ${kind}, got ${kinds.join(', ')}`);
    });
  }

  test('refuses with an error the caller can see', () => {
    const { result } = guarded("require('node:net').connect(80, 'vendor.invalid')", 'throws');
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /network guard refused connect vendor.invalid:80/);
  });

  test('guards child Node processes through NODE_OPTIONS', () => {
    const inner = "require('node:net').connect(80, 'child.invalid')";
    const script = `try { require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'ignore' }); } catch {}`;
    const { entries } = guarded(script, 'child');
    const targets = attemptsIn(entries).map((entry) => entry.target);
    assert.deepStrictEqual(targets, ['child.invalid:80']);
    assert.ok(entries.some((entry) => entry.kind === 'spawn'));
  });

  test('a process that makes no attempt leaves no attempt in the log', () => {
    const { result, entries } = guarded("require('node:fs').readFileSync(__filename)", 'quiet');
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(attemptsIn(entries), []);
  });
});

describe('peak-rss', () => {
  const PRELOAD = path.resolve(__dirname, '..', 'peak-rss.js');

  test('appends the peak memory of a process to the log when it exits', () => {
    const log = path.join(dir, 'rss.log');
    spawnSync(process.execPath, ['-e', 'Buffer.alloc(50 * 1024 * 1024, 1)'], {
      env: { ...process.env, NODE_OPTIONS: `--require "${PRELOAD}"`, PSP_RSS_LOG: log },
    });
    const [entry] = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(entry.maxRssKb > 50 * 1024, `peak ${entry.maxRssKb} KB`);
  });

  test('writes nothing without a log path', () => {
    const result = spawnSync(process.execPath, ['--require', PRELOAD, '-e', '0'], {
      env: { ...process.env, PSP_RSS_LOG: '' },
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, '');
  });
});
