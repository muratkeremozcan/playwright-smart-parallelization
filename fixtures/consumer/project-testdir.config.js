'use strict';

const { defineConfig } = require('@playwright/test');

// testDir is set inside the projects only, so the config rootDir is this directory and the test
// files are not relative to it as they are when testDir is top level. A list line names a file
// relative to the rootDir.
module.exports = defineConfig({
  reporter: 'list',
  projects: [
    { name: 'p', testDir: './identity-tests', testMatch: /(nested|siblings)\.spec\.js$/ },
    { name: 'q', testDir: './unselectable-tests', testMatch: /plain\.spec\.js$/ },
  ],
});
