'use strict';

const base = require('./playwright.config.js');

// The same projects with the setup project configured to repeat its tests. A dependency project
// that repeats because its config says so must still be a dependency.
module.exports = {
  ...base,
  projects: base.projects.map((project) =>
    project.name === 'setup' ? { ...project, repeatEach: 2 } : project
  ),
};
