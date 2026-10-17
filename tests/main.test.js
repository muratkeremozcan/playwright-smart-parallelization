/**
 * The entry point: an unknown step or phase fails with an error annotation, outputs reach
 * GITHUB_OUTPUT in the heredoc form, and the Action's code reads no private Playwright field.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../main');
const { errorCommand, setOutputs } = require('../lib/util');

const ROOT = path.join(__dirname, '..');

describe('main', () => {
  test('an unknown step fails with an annotation', async () => {
    const lines = [];
    assert.strictEqual(await main('nope', {}, (l) => lines.push(l)), 1);
    assert.match(lines[0], /^::error title=playwright-smart-parallelization::unknown step/);
  });

  test('the phase step refuses anything but prepare, run and finish', async () => {
    const lines = [];
    assert.strictEqual(await main('phase', { PSP_INPUT_PHASE: 'deploy' }, (l) => lines.push(l)), 1);
    assert.match(lines[0], /phase input must be one of prepare, run, finish/);
    assert.strictEqual(await main('phase', { PSP_INPUT_PHASE: 'run' }, () => {}), 0);
  });

  test('runs as a process from the action path', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'main.js'), 'phase'], {
      encoding: 'utf8',
      env: { ...process.env, PSP_INPUT_PHASE: '' },
      cwd: os.tmpdir(),
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /^::error title=playwright-smart-parallelization::/);
  });
});

test('outputs use a delimiter the value does not contain', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psp-out-')), 'out');
  setOutputs({ plan: '{"a":1}\nsecond line' }, { GITHUB_OUTPUT: file });
  const text = fs.readFileSync(file, 'utf8');
  const [first] = text.split('\n');
  const delimiter = first.split('<<')[1];
  assert.strictEqual(text, `plan<<${delimiter}\n{"a":1}\nsecond line\n${delimiter}\n`);
});

test('errorCommand escapes workflow command metacharacters', () => {
  assert.strictEqual(
    errorCommand('100%\r\nnext', 'a:b,c'),
    '::error title=a%3Ab%2Cc::100%25%0D%0Anext'
  );
});

test('the Action reads no private field of Playwright', () => {
  const files = [
    'main.js',
    ...['lib', 'lib/plan', 'reporter'].flatMap((dir) =>
      fs
        .readdirSync(path.join(ROOT, dir))
        .filter((f) => f.endsWith('.js'))
        .map((f) => `${dir}/${f}`)
    ),
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /\._[A-Za-z]\w*/, `${file} reads a private field`);
  }
});
