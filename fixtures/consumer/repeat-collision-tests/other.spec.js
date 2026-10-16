'use strict';

const { test, expect } = require('@playwright/test');

test('other', async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(true).toBe(true);
});
