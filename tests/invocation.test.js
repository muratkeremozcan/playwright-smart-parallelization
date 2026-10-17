'use strict';

/**
 * The command-line flags the reporter reads (lib/invocation.js), parsed the way Playwright's own
 * option parser reads them. tests/reporter-invocation.test.js runs the same forms on real
 * Playwright.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { parseInvocation } = require('../lib/invocation');

const parse = (...args) => parseInvocation(['node', 'cli.js', 'test', ...args]);
const NONE = { noDeps: false, lastFailed: false };
const NO_DEPS = { noDeps: true, lastFailed: false };

test('--no-deps anywhere among the options', () => {
  assert.deepStrictEqual(parse('--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('--shard=1/2', '--no-deps', '--workers', '2'), NO_DEPS);
  assert.deepStrictEqual(parse('--project=leaf', '--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('--project', 'setup', 'leaf', '--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('tests/a.spec.js', '--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('-x', '--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('-u', '--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('--only-changed', '--no-deps'), NO_DEPS);
  assert.deepStrictEqual(parse('-cplaywright.config.js', '--no-deps'), NO_DEPS);
});

test('a required value takes the next token, so --no-deps there is a value', () => {
  for (const option of ['--grep', '-g', '--grep-invert', '-G', '--reporter', '-c', '-j']) {
    assert.deepStrictEqual(parse(option, '--no-deps'), NONE, option);
  }
  assert.deepStrictEqual(parse('-xG', '--no-deps'), NONE, 'a short flag cluster ends in -G');
  assert.deepStrictEqual(parse('--grep=--no-deps'), NONE);
  assert.deepStrictEqual(parse('--last-failed-file', '--last-failed'), NONE);
});

test('after -- every token is a test filter', () => {
  assert.deepStrictEqual(parse('--', '--no-deps', '--last-failed'), NONE);
});

test('--last-failed with or without its file', () => {
  assert.deepStrictEqual(parse('--last-failed'), { noDeps: false, lastFailed: true });
  assert.deepStrictEqual(parse('--last-failed-file=x.json', '--last-failed', '--no-deps'), {
    noDeps: true,
    lastFailed: true,
  });
  assert.deepStrictEqual(parse('--last-failed-file', 'x.json'), NONE);
});

test('a command line without the test command is refused', () => {
  assert.throws(
    () => parseInvocation(['node', 'cli.js', 'merge-reports', '--no-deps']),
    /cannot find the playwright test command/
  );
  assert.throws(() => parseInvocation(['node', 'cli.js']), /cannot find the playwright test/);
  assert.deepStrictEqual(parseInvocation(['node', 'cli.js', 'test']), NONE);
});
