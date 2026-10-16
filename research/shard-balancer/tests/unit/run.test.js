/**
 * The collector's command line: flags, a missing install that names `npm run research:install`
 * with exit code 2, and the summary it prints for collected evidence.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectEvidence } = require('../../collect');
const { main, parseArgs } = require('../../run');
const { assertInstalled } = require('../../upstream');

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

describe('parseArgs', () => {
  test('takes --out and --group', () => {
    const options = parseArgs(['--out', 'x.json', '--group', 'history']);
    assert.strictEqual(options.out, path.resolve('x.json'));
    assert.strictEqual(options.group, 'history');
  });

  test('refuses --out without a value', () => {
    assert.throws(() => parseArgs(['--out']), /--out needs a value/);
  });

  test('refuses an unknown flag or group', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown flag/);
    assert.throws(() => parseArgs(['--group', 'nope']), /--group needs one of/);
  });
});

describe('a missing install', () => {
  test('is an error that names the install script', () => {
    const missing = path.join(os.tmpdir(), 'psp-psb-missing');
    assert.throws(
      () => assertInstalled({ root: missing }),
      (error) =>
        error.code === 'PSP_NOT_INSTALLED' && /npm run research:install/.test(error.message)
    );
  });

  test('names a missing fixture and a missing Flakiness install', () => {
    const missing = path.join(os.tmpdir(), 'psp-psb-missing');
    assert.throws(
      () => assertInstalled({ fixture: missing }),
      /the consumer fixture is not installed.*npm run research:install/
    );
    assert.throws(
      () => assertInstalled({ flakiness: missing }),
      /@flakiness\/playwright is not installed.*npm run research:install/
    );
  });

  test('stops the collection before any other work', async () => {
    const called = [];
    const stub = (name) => () => called.push(name);
    await assert.rejects(
      collectEvidence({
        deps: {
          assertInstalled: () => {
            throw Object.assign(new Error('not installed'), { code: 'PSP_NOT_INSTALLED' });
          },
          createContext: stub('createContext'),
          packageInfo: stub('packageInfo'),
          publishedCommit: stub('publishedCommit'),
        },
      }),
      /not installed/
    );
    assert.deepStrictEqual(called, []);
  });

  test('makes the collector exit 2 with that message alone', async () => {
    const stderr = sink();
    const code = await main([], {
      stdout: sink(),
      stderr,
      collect: async () => assertInstalled({ root: path.join(os.tmpdir(), 'psp-psb-missing') }),
    });
    assert.strictEqual(code, 2);
    assert.match(
      stderr.text(),
      /^error: playwright-shard-balancer is not installed .*npm run research:install/
    );
    assert.doesNotMatch(stderr.text(), /\n\s+at /);
  });
});

describe('collected evidence', () => {
  test('passes --group to the collection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-psb-run-'));
    try {
      let group = null;
      const evidence = {
        versions: { package: 'p', commit: 'c', playwright: '1' },
        rows: [],
        citations: [],
      };
      const code = await main(['--group', 'history', '--out', path.join(dir, 'e.json')], {
        stdout: sink(),
        stderr: sink(),
        collect: async (options) => {
          group = options.group;
          return evidence;
        },
      });
      assert.strictEqual(code, 0);
      assert.strictEqual(group, 'history');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is written to --out and summarized', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-psb-run-'));
    try {
      const out = path.join(dir, 'evidence.json');
      const stdout = sink();
      const evidence = {
        versions: {
          package: 'playwright-shard-balancer@0.0.1',
          commit: 'abc',
          playwright: '1.0.0',
        },
        rows: [{ id: 'a.x', status: 'pass' }],
        citations: [{ ok: true }, { ok: false }],
      };
      const code = await main(['--out', out], {
        stdout,
        stderr: sink(),
        collect: async () => evidence,
      });
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), evidence);
      assert.match(stdout.text(), /pass {2}a\.x/);
      assert.match(stdout.text(), /citations: 1 of 2 found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
