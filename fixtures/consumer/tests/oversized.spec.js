'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe.configure({ mode: 'serial' });

const steps = [];

for (const step of ['a', 'b', 'c', 'd', 'e']) {
  test(`oversized step ${step}`, async () => {
    await sleep(1800);
    steps.push(step);
    expect(steps.at(-1)).toBe(step);
  });
}
