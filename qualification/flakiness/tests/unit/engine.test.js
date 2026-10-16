/** Tests for the wrapper around the installed package: where it finds it and how it runs it. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildArgs,
  buildTimings,
  engineInfo,
  packageRoot,
  reporterPath,
  runTimings,
  timingsPath,
} = require('../../engine');

describe('the installed package', () => {
  test('is the one under qualification/flakiness, found from its reporter file', () => {
    const root = packageRoot();
    assert.ok(root.startsWith(path.resolve(__dirname, '..', '..')), root);
    assert.ok(fs.existsSync(reporterPath()));
    assert.ok(fs.existsSync(timingsPath()));
  });

  test('reports its name and resolved version', () => {
    const info = engineInfo();
    assert.strictEqual(info.name, '@flakiness/playwright');
    assert.match(info.version, /^\d+\.\d+\.\d+/);
  });

  test('takes both files from the root it is given', () => {
    assert.strictEqual(reporterPath('/x'), path.join('/x', 'lib', 'playwright-test.js'));
    assert.strictEqual(
      timingsPath('/x'),
      path.join('/x', 'lib', 'flakiness-playwright-timings.js')
    );
  });
});

describe('buildArgs', () => {
  test('lists the inputs in order and the output last', () => {
    assert.deepStrictEqual(buildArgs({ inputs: ['a.json', 'b.json'], output: 'o.json' }), [
      'build',
      'a.json',
      'b.json',
      '-o',
      'o.json',
    ]);
  });

  test('leaves out -o without an output', () => {
    assert.deepStrictEqual(buildArgs({ inputs: ['a.json'] }), ['build', 'a.json']);
  });
});

describe('runTimings', () => {
  test('runs the package command and returns its exit code, output and time', () => {
    const result = runTimings(['--help']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /flakiness-playwright-timings build/);
    assert.ok(result.ms > 0);
  });

  test('puts the wrap prefix in front of the command', () => {
    const result = runTimings(['--help'], { wrap: ['sh', '-c', 'exit 3', 'wrapped'] });
    assert.strictEqual(result.status, 3);
  });

  test('passes extra environment to the command', () => {
    const result = runTimings(['--help'], { env: { NODE_OPTIONS: '--no-such-node-option' } });
    assert.notStrictEqual(result.status, 0);
  });

  test('returns the error text of a command that fails', () => {
    const result = buildTimings({ inputs: [path.join(__dirname, 'absent.json')] });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /cannot read report/);
  });
});
