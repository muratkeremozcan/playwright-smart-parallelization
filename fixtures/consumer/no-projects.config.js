'use strict';

const { defineConfig } = require('@playwright/test');

// A config without `projects`: Playwright runs one implicit project whose name is ''.
module.exports = defineConfig({
  testDir: './tests',
  retries: 2,
  reporter: 'list',
});
