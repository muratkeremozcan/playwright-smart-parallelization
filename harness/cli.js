'use strict';

/**
 * Command line entry point.
 *
 *   node harness/cli.js [--cwd DIR] [--shards N] [--repeat-each N] [--workers N]
 *                       [--report FILE] [--negative-control] [-- playwright args]
 *
 * Exit code 0 means the partition covers the intended leaves with no violation (or, with
 * `--negative-control`, that the clean partition was accepted and every broken one rejected).
 * Exit code 1 means a violation, and exit code 2 a usage or runtime error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { qualify } = require('./index');
const { runNegativeControl } = require('./negative-control');

const DEFAULT_REPORT = 'harness-report.json';

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} needs a positive integer, got ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    shards: 2,
    repeatEach: 1,
    workers: 1,
    report: DEFAULT_REPORT,
    negativeControl: false,
    forward: [],
  };
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  options.forward = separator === -1 ? [] : argv.slice(separator + 1);
  for (let i = 0; i < own.length; i += 1) {
    const flag = own[i];
    const value = () => {
      i += 1;
      if (i >= own.length) throw new Error(`${flag} needs a value`);
      return own[i];
    };
    if (flag === '--cwd') options.cwd = path.resolve(value());
    else if (flag === '--shards') options.shards = positiveInteger(flag, value());
    else if (flag === '--repeat-each') options.repeatEach = positiveInteger(flag, value());
    else if (flag === '--workers') options.workers = positiveInteger(flag, value());
    else if (flag === '--report') options.report = value();
    else if (flag === '--negative-control') options.negativeControl = true;
    else throw new Error(`unknown flag ${flag}`);
  }
  return options;
}

function execute(options, { out, stderr, qualifyRun, negativeRun }) {
  if (options.negativeControl) {
    const result = negativeRun(options, { log: out });
    fs.writeFileSync(options.report, `${JSON.stringify(result, null, 2)}\n`);
    if (result.ok) {
      out(
        'Negative control passed: the clean partition was accepted and every broken one rejected.'
      );
    } else {
      stderr.write('Negative control failed: a control did not behave as expected.\n');
    }
    return result.ok ? 0 : 1;
  }

  const report = qualifyRun(options, { log: out });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const shard of report.shards) {
    out(
      `Shard ${shard.index}: ${shard.leafCount} leaves, ${shard.durationMs} ms ` +
        `(wall ${shard.wallMs} ms), exit ${shard.exitCode}`
    );
  }
  out(`Slowest shard: ${report.slowestShard}, imbalance ${(report.imbalance * 100).toFixed(1)}%`);
  for (const violation of report.violations) {
    stderr.write(
      `violation ${violation.kind} ${violation.key || violation.group || `shard ${violation.shard}`}: ` +
        `${violation.detail}\n`
    );
  }
  out(`Report written to ${options.report}`);
  out(report.ok ? 'Qualification passed.' : 'Qualification failed.');
  return report.ok ? 0 : 1;
}

/**
 * Runs the CLI and returns the exit code. `qualify` and `runNegativeControl` replace the real
 * runs (tests inject stubs). A usage or runtime error prints `error: <message>` and returns 2, so
 * it never reads as a violation.
 */
function main(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    qualify: qualifyRun = qualify,
    runNegativeControl: negativeRun = runNegativeControl,
  } = {}
) {
  const out = (line) => stdout.write(`${line}\n`);
  try {
    return execute(parseArgs(argv), { out, stderr, qualifyRun, negativeRun });
  } catch (error) {
    stderr.write(`error: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs };
