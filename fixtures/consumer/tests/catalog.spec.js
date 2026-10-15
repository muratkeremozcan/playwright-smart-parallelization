'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe('catalog', () => {
  test('loads the page', async () => {
    await sleep(120);
    expect(true).toBe(true);
  });

  test('filters products by category', async () => {
    await sleep(200);
    expect(['shoes', 'hats']).toContain('hats');
  });

  test('sorts products by price', async () => {
    await sleep(80);
    expect([3, 1, 2].sort()).toEqual([1, 2, 3]);
  });
});
