'use strict';

// The consumer fixture with its workers set in the config alone, for the e2e leg whose command
// passes no --workers.
module.exports = { ...require('./playwright.config.js'), workers: 3 };
