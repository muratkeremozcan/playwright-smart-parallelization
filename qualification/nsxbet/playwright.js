'use strict';

/**
 * Playwright calls the qualification makes on its own, next to the harness: the raw JSON list the
 * engine reads, and the CLI path of the project under test.
 */

const { spawnSync } = require('node:child_process');

const MAX_BUFFER = 256 * 1024 * 1024;

/** The `@playwright/test` file `request` resolves to for the project at `cwd`. */
function resolveFromCwd(request, cwd) {
  return require.resolve(request, { paths: [cwd] });
}

/** `playwright test --list --reporter=json` for the project at `cwd`, parsed. */
function listJson(cwd, args = []) {
  const cli = resolveFromCwd('@playwright/test/cli', cwd);
  const result = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0) {
    throw new Error(`playwright test --list failed (exit ${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * The ids the engine derives from a list JSON: the file, then the titles of the enclosing
 * describe blocks and of the test, joined by `::`. The title of a file suite is the file name and
 * is left out.
 */
function engineIds(json) {
  const ids = [];
  const visit = (suite, titles, root) => {
    const own = root || !suite.title ? titles : [...titles, suite.title];
    for (const spec of suite.specs || []) {
      ids.push([spec.file || suite.file, ...own, spec.title].join('::'));
    }
    for (const child of suite.suites || []) visit(child, own, false);
  };
  for (const suite of json.suites) visit(suite, [], true);
  return ids;
}

module.exports = { engineIds, listJson, resolveFromCwd };
