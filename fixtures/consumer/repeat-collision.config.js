'use strict';

const { defineConfig } = require('@playwright/test');

// A test whose title reads like the second repeat of another, for identity under --repeat-each.
module.exports = defineConfig({
  testDir: './repeat-collision-tests',
  reporter: 'list',
  projects: [{ name: 'chromium' }, { name: 'firefox' }],
});
