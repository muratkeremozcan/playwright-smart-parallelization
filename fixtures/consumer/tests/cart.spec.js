'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe('cart', () => {
  test('loads the page', async () => {
    await sleep(90);
    expect(true).toBe(true);
  });

  test('adds an item', async () => {
    await sleep(150);
    expect([1].concat(2)).toHaveLength(2);
  });

  test('removes an item', async () => {
    await sleep(110);
    expect([1, 2].slice(1)).toEqual([2]);
  });
});
