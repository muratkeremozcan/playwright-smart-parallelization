'use strict';

const { test } = require('@playwright/test');

/** Registers the same tests from one call site, once per spec file that calls it. */
function registerShared(prefix) {
  test(`${prefix} loads`, async () => {});
  test(`${prefix} saves`, async () => {});
}

/** A serial suite built at one call site: every call makes a sibling with this location. */
function serialSuite(title) {
  test.describe(title, () => {
    test.describe.configure({ mode: 'serial' });
    test('first', async () => {});
    test('second', async () => {});
  });
}

module.exports = { registerShared, serialSuite };
