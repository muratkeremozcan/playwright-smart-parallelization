'use strict';

const { defineConfig } = require('@playwright/test');

// Identity shapes the leaf and serial group keys must tell apart: two unnamed projects, tests
// registered by a shared factory from several spec files, nested serial suites whose inner suite is
// declared in a helper above the outer one, and sibling serial suites built at one call site.
module.exports = defineConfig({
  testDir: './identity-tests',
  reporter: 'list',
  projects: [
    { name: 'one', testMatch: /.*\.spec\.js/ },
    { name: 'two', testMatch: /.*\.spec\.js/ },
  ],
});
