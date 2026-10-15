'use strict';

/**
 * Runs every qualification check against the installed engine and writes the evidence JSON.
 *
 *   node qualification/nsxbet/run.js [--out FILE] [--require-os-block]
 *
 * Exit code 0 means the evidence was collected, 2 a runtime error. Whether each result is the
 * expected one is asserted by the tests in `qualification/nsxbet/tests`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { collectEvidence } = require('./proofs');

const DEFAULT_OUT = path.join(__dirname, 'evidence.json');

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, requireOsBlock: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      i += 1;
      if (i >= argv.length) throw new Error('--out needs a value');
      options.out = path.resolve(argv[i]);
    } else if (argv[i] === '--require-os-block') {
      options.requireOsBlock = true;
    } else {
      throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return options;
}

async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    const started = Date.now();
    const evidence = await collectEvidence({
      requireOsBlock: options.requireOsBlock,
      log: (line) => stderr.write(`[${Math.round((Date.now() - started) / 1000)}s] ${line}\n`),
    });
    fs.writeFileSync(options.out, `${JSON.stringify(evidence, null, 2)}\n`);
    stdout.write(`${evidence.versions.engine}, Playwright ${evidence.versions.playwright}\n`);
    for (const row of evidence.rows) stdout.write(`${row.status.padEnd(7)} ${row.id}\n`);
    for (const proof of evidence.proofs) stdout.write(`proof ${proof.number}: ${proof.status}\n`);
    stdout.write(`Evidence written to ${options.out}\n`);
    return 0;
  } catch (error) {
    stderr.write(`error: ${error.stack || error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, parseArgs };
