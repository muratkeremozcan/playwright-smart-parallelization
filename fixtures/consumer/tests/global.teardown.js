'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

test('clean up the environment', async () => {
  await sleep(50);
});
