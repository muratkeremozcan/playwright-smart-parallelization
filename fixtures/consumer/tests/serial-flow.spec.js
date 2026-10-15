'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe.configure({ mode: 'serial' });

let signedIn = false;

test('one signs in', async () => {
  await sleep(160);
  signedIn = true;
});

test('two uses the session from one', async () => {
  await sleep(240);
  expect(signedIn).toBe(true);
});
