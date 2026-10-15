'use strict';

const { defineConfig } = require('@playwright/test');

// Browser-free consumer used to qualify sharding engines. The browser projects carry names only,
// so no browser is ever installed or launched.
module.exports = defineConfig({
  testDir: './tests',
  retries: 2,
  reporter: 'list',
  projects: [
    { name: 'setup', testMatch: /global\.setup\.js/, teardown: 'teardown' },
    { name: 'teardown', testMatch: /global\.teardown\.js/ },
    { name: 'chromium', testMatch: /.*\.spec\.js/, dependencies: ['setup'] },
    { name: 'firefox', testMatch: /.*\.spec\.js/, dependencies: ['setup'] },
  ],
});
