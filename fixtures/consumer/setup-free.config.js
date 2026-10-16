'use strict';

const { defineConfig } = require('@playwright/test');

// The main config with one browser project that needs no setup, so a balanced shard can host only
// tests that need none.
module.exports = defineConfig({
  testDir: './tests',
  retries: 2,
  reporter: 'list',
  projects: [
    { name: 'setup', testMatch: /global\.setup\.js/, teardown: 'teardown' },
    { name: 'teardown', testMatch: /global\.teardown\.js/ },
    { name: 'chromium', testMatch: /.*\.spec\.js/, dependencies: ['setup'] },
    { name: 'firefox', testMatch: /.*\.spec\.js/ },
  ],
});
