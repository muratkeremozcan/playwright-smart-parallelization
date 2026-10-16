'use strict';

const { expect, record, sleep, test, testEvent } = require('./fixtures');

// The first attempt fails, so Playwright stops that worker (its cleanup runs) and retries in a new
// worker.
test('fails once and passes in a new worker', async ({}, info) => {
  await sleep(20);
  const failing = info.retry === 0;
  record('test', info, { ...testEvent(info), status: failing ? 'failed' : 'passed' });
  expect(failing).toBe(false);
});

test('runs after the replacement', async ({}, info) => {
  await sleep(20);
  record('test', info, { ...testEvent(info), status: 'passed' });
});
