'use strict';

/**
 * Runs every qualification check against the installed engine and writes the evidence JSON.
 *
 *   node qualification/flakiness/run.js [--out FILE] [--require-os-block] [--group NAME]
 *   node qualification/flakiness/run.js --merge PART.json... [--out FILE]
 *
 * `--group` collects one group of scenarios (coverage, serial, balance, assignment, history or
 * privacy), so groups can run on separate runners; `--merge` joins the evidence files of all groups.
 *
 * Exit code 0 means the evidence was collected, 2 a runtime error. Whether each result is the
 * expected one is asserted by the tests in `qualification/flakiness/tests`.
 */

const path = require('node:path');
const { createRunner } = require('../lib/run');
const { GROUP_NAMES, collectEvidence, mergeEvidence } = require('./proofs');

const { main, parseArgs } = createRunner({
  GROUP_NAMES,
  collectEvidence,
  mergeEvidence,
  defaultOut: path.join(__dirname, 'evidence.json'),
});

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, parseArgs };
