'use strict';

const { expect, record, sleep, test, testEvent } = require('./fixtures');

// The first attempt fails slowly, so Playwright stops that worker (its cleanup runs) and retries
// in a new worker, where it passes quickly. The history samples the quick passing attempt.
test('fails once and passes in a new worker', async ({}, info) => {
  const failing = info.retry === 0;
  await sleep(failing ? 600 : 30);
  record('test', info, { ...testEvent(info), status: failing ? 'failed' : 'passed' });
  expect(failing).toBe(false);
});

test('runs after the replacement', async ({}, info) => {
  await sleep(20);
  record('test', info, { ...testEvent(info), status: 'passed' });
});
