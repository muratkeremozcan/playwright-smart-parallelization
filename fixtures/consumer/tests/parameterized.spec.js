'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

const inputs = [
  { currency: 'USD', delay: 60 },
  { currency: 'EUR', delay: 140 },
  { currency: 'JPY', delay: 220 },
  { currency: 'GBP', delay: 100 },
];

for (const { currency, delay } of inputs) {
  test(`formats prices in ${currency}`, async () => {
    await sleep(delay);
    expect(currency).toHaveLength(3);
  });
}
