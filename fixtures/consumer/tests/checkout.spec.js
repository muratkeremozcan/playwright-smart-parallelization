'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe.configure({ mode: 'parallel' });

test('applies a discount code', async () => {
  await sleep(300);
  expect(100 * 0.9).toBe(90);
});

test('calculates shipping', async () => {
  await sleep(180);
  expect(5 + 2).toBe(7);
});

test('submits the order', async () => {
  await sleep(400);
  expect('placed').toBe('placed');
});

test('shows the confirmation', async () => {
  await sleep(70);
  expect('ok').toBe('ok');
});
