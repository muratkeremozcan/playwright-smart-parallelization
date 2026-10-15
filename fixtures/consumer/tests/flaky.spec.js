'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test('recovers after a retry', async () => {
  await sleep(130);
  expect(test.info().retry).toBeGreaterThan(0);
});
