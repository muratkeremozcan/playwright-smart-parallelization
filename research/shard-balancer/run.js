'use strict';

/**
 * Collects the evidence of the harvest and writes it as JSON.
 *
 *   node research/shard-balancer/run.js [--out FILE] [--group NAME]
 *
 * `--group` collects one group of rows (for a quick look at one area; the tests expect every
 * group). Exit code 0 means the evidence was collected, 2 a runtime error, such as a missing
 * install. Whether each row holds its expected status is asserted by the tests in
 * `research/shard-balancer/tests`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { GROUP_NAMES, collectEvidence } = require('./collect');

const DEFAULT_OUT = path.join(__dirname, 'evidence.json');

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, group: 'all' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      i += 1;
      if (i >= argv.length) throw new Error('--out needs a value');
      options.out = path.resolve(argv[i]);
    } else if (argv[i] === '--group') {
      i += 1;
      if (!GROUP_NAMES.includes(argv[i]))
        throw new Error(`--group needs one of ${GROUP_NAMES.join(', ')}`);
      options.group = argv[i];
    } else {
      throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return options;
}

async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr, collect = collectEvidence } = {}
) {
  try {
    const options = parseArgs(argv);
    const started = Date.now();
    const evidence = await collect({
      group: options.group,
      log: (line) => stderr.write(`[${Math.round((Date.now() - started) / 1000)}s] ${line}\n`),
    });
    fs.writeFileSync(options.out, `${JSON.stringify(evidence, null, 2)}\n`);
    stdout.write(
      `${evidence.versions.package} at ${evidence.versions.commit}, Playwright ${evidence.versions.playwright}\n`
    );
    for (const row of evidence.rows) stdout.write(`${row.status.padEnd(5)} ${row.id}\n`);
    const bad = evidence.citations.filter((c) => !c.ok);
    stdout.write(
      `citations: ${evidence.citations.length - bad.length} of ${evidence.citations.length} found\n`
    );
    stdout.write(`Evidence written to ${options.out}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `error: ${error.code === 'PSP_NOT_INSTALLED' ? error.message : error.stack || error.message}\n`
    );
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, parseArgs };
