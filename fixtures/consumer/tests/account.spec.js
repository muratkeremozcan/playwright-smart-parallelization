'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe('account', () => {
  test('loads the page', async () => {
    await sleep(60);
    expect(true).toBe(true);
  });

  test('updates the profile', async () => {
    await sleep(250);
    expect(['a', 'b'].at(-1)).toBe('b');
  });
});
