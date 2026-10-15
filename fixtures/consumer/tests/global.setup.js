'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

test('prepare the environment', async () => {
  await sleep(50);
});
