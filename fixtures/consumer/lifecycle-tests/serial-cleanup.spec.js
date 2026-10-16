'use strict';

const { expect, record, sleep, test, testEvent } = require('./fixtures');

// A serial group: the second test fails on the first attempt, so the whole group retries, and the
// afterAll cleanup runs after each attempt.
test.describe.serial('serial cleanup', () => {
  test.afterAll(async ({}, info) => {
    record('serial-cleanup', info, {
      file: 'serial-cleanup.spec.js',
      repeat: info.repeatEachIndex,
      retry: info.retry,
    });
  });

  test('first step', async ({}, info) => {
    await sleep(20);
    record('test', info, { ...testEvent(info), status: 'passed' });
  });

  test('second step fails once', async ({}, info) => {
    await sleep(20);
    const failing = info.retry === 0;
    record('test', info, { ...testEvent(info), status: failing ? 'failed' : 'passed' });
    expect(failing).toBe(false);
  });
});
