'use strict';

const { defineConfig } = require('@playwright/test');

// Two projects without a name, which Playwright accepts and the harness rejects.
module.exports = defineConfig({
  testDir: './identity-tests',
  reporter: 'list',
  projects: [{ testMatch: /.*\.spec\.js/ }, { testMatch: /.*\.spec\.js/ }],
});
