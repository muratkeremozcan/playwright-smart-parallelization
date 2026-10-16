'use strict';

const { test } = require('@playwright/test');

/**
 * Waits for `ms` milliseconds. Tests use it to give each leaf a known, varied duration. With
 * `PSP_FIXTURE_SKIP_ALL=1`, every test skips at runtime instead. The harness negative control
 * sets it to prove a selected test that never ran does not count as covered. With
 * `PSP_FIXTURE_FAIL=text`, every attempt of a test whose title path contains the text fails, which
 * the Action's end-to-end jobs use for a failed shard.
 */
async function sleep(ms) {
  if (process.env.PSP_FIXTURE_SKIP_ALL === '1') test.info().skip();
  const fail = process.env.PSP_FIXTURE_FAIL;
  if (fail && test.info().titlePath.join(' › ').includes(fail)) {
    throw new Error(`PSP_FIXTURE_FAIL matched ${JSON.stringify(fail)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { sleep };
