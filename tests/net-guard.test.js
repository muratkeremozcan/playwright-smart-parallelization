/**
 * Tests for the network guard preload `tests/reporter-safety.test.js` runs the reporter under: it
 * must record and refuse every kind of attempt, so a run that logs none made none.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GUARD = path.join(__dirname, 'support', 'net-guard.js');
const ATTEMPTS = ['connect', 'dns.', 'fetch'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-guard-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const attemptsIn = (log) =>
  log.filter((entry) => ATTEMPTS.some((kind) => entry.kind.startsWith(kind)));

function guarded(script, name) {
  const log = path.join(dir, `${name}.log`);
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require "${GUARD}"`, PSP_NET_GUARD_LOG: log },
  });
  return { result, entries: readLog(log) };
}

describe('net-guard', () => {
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
