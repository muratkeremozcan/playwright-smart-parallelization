'use strict';

const { test, expect } = require('@playwright/test');

test('target', async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(true).toBe(true);
});

test('target (repeat 1)', async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(true).toBe(true);
});
