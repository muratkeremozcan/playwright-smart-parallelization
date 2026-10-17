'use strict';

const { defineConfig } = require('@playwright/test');
const base = require('./playwright.config');

// The main config with a blob reporter of its own, as a consumer that already merges reports has.
module.exports = defineConfig({ ...base, reporter: 'blob' });
