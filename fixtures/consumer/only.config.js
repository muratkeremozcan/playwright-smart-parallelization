'use strict';

const { defineConfig } = require('@playwright/test');

// A focused test with forbidOnly off: a run executes only the focused test.
module.exports = defineConfig({
  testDir: './only-tests',
  forbidOnly: false,
  reporter: 'list',
  projects: [{ name: 'only' }],
});
