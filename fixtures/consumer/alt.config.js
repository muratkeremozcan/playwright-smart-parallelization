'use strict';

const base = require('./playwright.config.js');

// The same project without the firefox browser project. Tests of the harness select it with every
// spelling of Playwright's config flag to prove forwarded arguments reach Playwright unchanged.
module.exports = {
  ...base,
  projects: base.projects.filter((project) => project.name !== 'firefox'),
};
