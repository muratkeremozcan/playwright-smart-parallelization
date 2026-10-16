'use strict';

const { test } = require('@playwright/test');

// A test titled like a suite: a list line for `group` also selects every test under the suite.
test('group', async () => {});

test.describe('group', () => {
  test('child', async () => {});
});
