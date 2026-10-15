/**
 * Tests for the action stub.
 *
 * The stub fails on purpose until the balancing logic exists. What matters is that it can never
 * pass, that it says why in a form GitHub renders as an annotation, and that the process exit code
 * carries the failure.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const action = require('../main.js');

describe('run', () => {
  test('fails with the not-implemented annotation', () => {
    const lines = [];
    const code = action.run((line) => lines.push(line));
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, [
      `::error title=${action.NOT_IMPLEMENTED_TITLE}::${action.NOT_IMPLEMENTED_MESSAGE}`,
    ]);
    assert.match(action.NOT_IMPLEMENTED_MESSAGE, /not implemented/);
  });
});

describe('errorCommand', () => {
  test('escapes workflow command metacharacters', () => {
    assert.strictEqual(
      action.errorCommand('a:b,c', '100%\r\nnext'),
      '::error title=a%3Ab%2Cc::100%25%0D%0Anext'
    );
  });
});

describe('main.js as a process', () => {
  test('exits 1 and prints the annotation, whatever the inputs', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js')], {
      encoding: 'utf8',
      env: { ...process.env, INPUT_ENABLED: 'false', 'INPUT_SHARD-COUNT': '4' },
    });
    assert.strictEqual(result.status, 1);
    assert.match(
      result.stdout,
      /^::error title=playwright-smart-parallelization::.*not implemented/
    );
  });
});
