/**
 * The user's command: split like a POSIX simple command, refused when it holds shell syntax or an
 * option the Action owns, and joined with the shard's own arguments into one `--add-reporter`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { assertSupported, parseCommand, shardArgv, takeAddReporters } = require('../lib/command');

describe('parseCommand', () => {
  test('splits words with quotes and escapes', () => {
    assert.deepStrictEqual(parseCommand(`npx playwright test --grep "@smoke tag" -g 'a b' x\\ y`), [
      'npx',
      'playwright',
      'test',
      '--grep',
      '@smoke tag',
      '-g',
      'a b',
      'x y',
    ]);
    assert.deepStrictEqual(parseCommand('a "b\\"c"'), ['a', 'b"c']);
  });

  for (const command of [
    'a && b',
    'a; b',
    'a | b',
    'a > out',
    'a $HOME',
    'a "$HOME"',
    'a `x`',
    'a $(x)',
  ]) {
    test(`refuses shell syntax: ${command}`, () =>
      assert.throws(() => parseCommand(command), /shell|expand/));
  }

  test('refuses an empty command and unbalanced quotes', () => {
    assert.throws(() => parseCommand('  '), /empty/);
    assert.throws(() => parseCommand('a "b'), /unbalanced/);
    assert.throws(() => parseCommand("a 'b"), /unbalanced/);
  });
});

describe('assertSupported', () => {
  for (const arg of [
    '--shard=1/2',
    '--shard',
    '--workers=2',
    '-j4',
    '--last-failed',
    '--only-changed',
    '--list',
    '--no-deps',
    '--',
  ]) {
    test(`refuses ${arg}`, () =>
      assert.throws(() => assertSupported(['npx', 'playwright', 'test', arg]), /may not contain/));
  }

  test('accepts selections the Action keeps the meaning of', () => {
    assertSupported([
      'npx',
      'playwright',
      'test',
      '--project=chromium',
      '--grep',
      'x',
      '--repeat-each=2',
    ]);
  });
});

describe('the arguments of a shard', () => {
  test('folds the user --add-reporter values into one with the Action reporter last', () => {
    assert.deepStrictEqual(
      shardArgv('npx playwright test --add-reporter=dot --add-reporter json -x', {
        shard: 2,
        total: 3,
        workers: 4,
        reporter: '/action/reporter.js',
      }),
      [
        'npx',
        'playwright',
        'test',
        '-x',
        '--shard=2/3',
        '--workers=4',
        '--add-reporter=dot,json,blob,/action/reporter.js',
      ]
    );
  });

  test('passes no --workers when the input is empty', () => {
    assert.deepStrictEqual(
      shardArgv('npx playwright test', { shard: 1, total: 2, reporter: 'r.js' }),
      ['npx', 'playwright', 'test', '--shard=1/2', '--add-reporter=blob,r.js']
    );
  });

  test('adds the blob reporter once, and leaves it out when the command names one', () => {
    const last = (command) => shardArgv(command, { shard: 1, total: 2 }).pop();
    assert.strictEqual(last('npx playwright test'), '--add-reporter=blob');
    assert.strictEqual(last('npx playwright test --reporter=blob'), '--shard=1/2');
    assert.strictEqual(last('npx playwright test --reporter list,blob'), '--shard=1/2');
    assert.strictEqual(last('npx playwright test --add-reporter=blob'), '--add-reporter=blob');
  });

  test('refuses an --add-reporter with no value', () => {
    assert.throws(() => takeAddReporters(['--add-reporter']), /no value/);
  });
});
