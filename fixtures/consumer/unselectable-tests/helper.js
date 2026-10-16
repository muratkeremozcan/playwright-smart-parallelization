'use strict';

const { test } = require('@playwright/test');

/** Registers a test from a helper file, so the spec that calls it is not where the test sits. */
module.exports = () => {
  test('from a helper', async () => {});
};
