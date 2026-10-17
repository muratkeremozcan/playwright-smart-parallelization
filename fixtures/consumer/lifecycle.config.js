'use strict';

const { defineConfig } = require('@playwright/test');

// Browser-free lifecycle fixture: worker-scoped fixtures, a shared beforeAll and afterAll, a
// failure that replaces its worker and a serial group that retries. Every hook and test appends
// an event to the file `PSP_LIFECYCLE_LOG` names, so a test can compare the lifecycle of a native
// run with a balanced one.
module.exports = defineConfig({
  testDir: './lifecycle-tests',
  retries: 1,
  reporter: 'list',
  projects: [{ name: 'alpha' }, { name: 'beta' }],
});
