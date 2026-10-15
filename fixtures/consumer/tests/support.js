'use strict';

/** Waits for `ms` milliseconds. Tests use it to give each leaf a known, varied duration. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { sleep };
