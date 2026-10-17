'use strict';

const { defineConfig } = require('@playwright/test');
const base = require('./playwright.config');

// A blob reporter whose config names its own output file, which beats PLAYWRIGHT_BLOB_OUTPUT_DIR
// but not PLAYWRIGHT_BLOB_OUTPUT_FILE.
module.exports = defineConfig({
  ...base,
  reporter: [['blob', { outputFile: 'configured/report.zip' }]],
});
