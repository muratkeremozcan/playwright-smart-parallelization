'use strict';

const { test } = require('@playwright/test');

/**
 * Waits for `ms` milliseconds. Tests use it to give each leaf a known, varied duration. With
 * `PSP_FIXTURE_SKIP_ALL=1`, every test skips at runtime instead. The harness negative control
 * sets it to prove a selected test that never ran does not count as covered.
 */
async function sleep(ms) {
  if (process.env.PSP_FIXTURE_SKIP_ALL === '1') test.info().skip();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { sleep };
