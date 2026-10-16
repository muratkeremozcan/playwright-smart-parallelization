'use strict';

const base = require('./playwright.config.js');

// The same projects with the chromium project renamed to a name that is also an Object.prototype
// accessor. Project names are user strings, and no table keyed by them may lose such a name.
module.exports = {
  ...base,
  projects: base.projects.map((project) =>
    project.name === 'chromium' ? { ...project, name: '__proto__' } : project
  ),
};
