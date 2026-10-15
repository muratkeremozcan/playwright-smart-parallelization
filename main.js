'use strict';

/**
 * Playwright Smart Parallelization: the GitHub Actions entry point.
 *
 * The balancing logic is not built yet. Until it is, the action fails on purpose with a clear
 * message, so a workflow that adopts it early cannot mistake a no-op for a balanced run.
 *
 * Zero runtime dependencies: no node_modules to audit and no bundle step.
 */

const NOT_IMPLEMENTED_TITLE = 'playwright-smart-parallelization';
const NOT_IMPLEMENTED_MESSAGE =
  'playwright-smart-parallelization is not implemented yet. This release ships the repository ' +
  'skeleton only, so the action fails instead of running your tests unbalanced.';

/** Escapes a workflow command message the way @actions/core does. */
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escapes a workflow command property value the way @actions/core does. */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function errorCommand(title, message) {
  return `::error title=${escapeProperty(title)}::${escapeData(message)}`;
}

/** Runs the action and returns the process exit code. */
function run(write = (line) => process.stdout.write(`${line}\n`)) {
  write(errorCommand(NOT_IMPLEMENTED_TITLE, NOT_IMPLEMENTED_MESSAGE));
  return 1;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { NOT_IMPLEMENTED_MESSAGE, NOT_IMPLEMENTED_TITLE, errorCommand, run };
