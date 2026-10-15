'use strict';

/**
 * Playwright reporter that records every leaf a shard selected, with its outcome. Playwright adds
 * it per shard run (`--add-reporter`) and it writes JSON to the path in `PSP_HARNESS_RESULT`:
 * `{ durationMs, leaves: [...] }`. It uses only the public Reporter API.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildLeaf, toPosix } = require('./leaves');

function leafOf(test) {
  const testDir = test.parent.project().testDir;
  const project = test.parent.project().name;
  const file = toPosix(path.relative(testDir, test.location.file));
  const leaf = buildLeaf({
    project,
    file,
    // titlePath() is ['', project, file, ...describes, title].
    titlePath: test.titlePath().slice(3),
    repeatIndex: test.repeatEachIndex,
    annotations: test.annotations,
    testDir,
    line: test.location.line,
    column: test.location.column,
  });
  delete leaf.dependency;
  return {
    ...leaf,
    outcome: test.outcome(),
    attempts: test.results.length,
    durationMs: test.results.reduce((total, result) => total + result.duration, 0),
  };
}

class HarnessReporter {
  constructor() {
    this.suite = null;
    this.startedAt = 0;
  }

  onBegin(_config, suite) {
    this.suite = suite;
    this.startedAt = Date.now();
  }

  onEnd(result) {
    const target = process.env.PSP_HARNESS_RESULT;
    if (!target || !this.suite) return;
    const durationMs =
      typeof result.duration === 'number' ? result.duration : Date.now() - this.startedAt;
    const leaves = this.suite.allTests().map(leafOf);
    fs.writeFileSync(target, JSON.stringify({ durationMs, leaves }, null, 2));
  }

  printsToStdio() {
    return false;
  }
}

module.exports = HarnessReporter;
module.exports.leafOf = leafOf;
