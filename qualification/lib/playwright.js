'use strict';

/** Resolution of the Playwright installed in the project under test. */

/** The file `request` resolves to for the project at `cwd`. */
function resolveFromCwd(request, cwd) {
  return require.resolve(request, { paths: [cwd] });
}

module.exports = { resolveFromCwd };
