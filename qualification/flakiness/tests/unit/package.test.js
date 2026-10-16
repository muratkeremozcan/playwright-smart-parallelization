/**
 * The mechanism the document describes, read from the installed package: the reporter plans in
 * `Reporter.preprocess`, excludes the tests of other shards, switches Playwright's split off,
 * prices unknown tests at one second, reads the commit through git and uploads only when the
 * upload is not disabled. The package floats to the latest release, so a release that changes any
 * of these fails here before the document goes stale.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { reporterPath } = require('../../engine');

const source = fs.readFileSync(reporterPath(), 'utf8');

/** The text of the `preprocess` method, up to the next method of the class. */
function preprocess() {
  const start = source.indexOf('async preprocess(');
  assert.ok(start >= 0, 'no preprocess method');
  return source.slice(start, source.indexOf('onBegin(config', start));
}

describe('the reporter source', () => {
  test('plans in Reporter.preprocess, and only for a sharded run with shardBalancing', () => {
    assert.match(
      preprocess(),
      /const balancing = this\._options\.shardBalancing;\s+if \(!balancing \|\| !config2\.shard\)\s+return;/
    );
  });

  test('excludes every test of the other shards and switches the native split off', () => {
    const body = preprocess();
    assert.match(body, /testRun\.exclude\(test\)/);
    assert.match(body, /testRun\.skipSharding\(\)/);
    assert.ok(body.indexOf('testRun.exclude') < body.indexOf('testRun.skipSharding'));
  });

  test('reads the timings file and the commit before it plans, and fails the run on any error', () => {
    const body = preprocess();
    assert.match(body, /GitWorktree\.initialize\(config2\.rootDir\)/);
    assert.match(body, /readReportFile\(balancing\.timingsFile/);
    assert.match(
      body,
      /throw new Error\(`\[flakiness\.io\] failed to generate balanced shard: \$\{reason\}`\)/
    );
  });

  test('prices a test the timings file does not know at one second', () => {
    assert.match(source, /var DEFAULT_DURATION = 1e3;/);
    assert.match(source, /durationPredictions\.get\(testCase\) \?\? DEFAULT_DURATION/);
  });

  test('allocates greedily, with no clock in the allocator', () => {
    const start = source.indexOf('function balanceShards');
    const end = source.indexOf('function setDifference', start);
    const allocator = source.slice(start, end);
    assert.doesNotMatch(allocator, /Date\.now|performance\.now|setTimeout|Math\.random/);
  });

  test('falls back to the native split with a warning when preprocess never ran', () => {
    assert.match(
      source,
      /shardBalancing requires Playwright 1\.62\+ \(Reporter\.preprocess API\); using Playwright's native sharding instead/
    );
  });

  test('uploads in onExit only when the upload is not disabled', () => {
    assert.match(
      source,
      /const disableUpload = this\._options\.disableUpload \?\? envBool\("FLAKINESS_DISABLE_UPLOAD"\);\s+if \(!disableUpload\) \{\s+await uploadReport\(/
    );
  });
});
