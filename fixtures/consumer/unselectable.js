'use strict';

const { defineConfig } = require('@playwright/test');

/**
 * A config over one spec of `unselectable-tests`, which Playwright runs but `--test-list` cannot
 * select exactly: a title with a separator, a control character or a newline, surrounding
 * whitespace, a test whose title is a suite's title, or a project name with a separator.
 */
module.exports = (spec, projectName = 'p') =>
  defineConfig({
    testDir: './unselectable-tests',
    reporter: 'list',
    projects: [{ name: projectName, testMatch: new RegExp(`${spec}\\.spec\\.js$`) }],
  });
