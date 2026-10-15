'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe.configure({ mode: 'serial' });

let prepared = false;

test('one prepares state and fails on the first attempt', async () => {
  await sleep(100);
  expect(test.info().retry).toBeGreaterThan(0);
  prepared = true;
});

test('two depends on the state from one', async () => {
  await sleep(140);
  expect(prepared).toBe(true);
});
