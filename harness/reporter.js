'use strict';

/**
 * Playwright reporter that records every leaf a run selected, with its outcome, and the projects of
 * the config with their dependencies. Playwright adds it per shard run (`--add-reporter`) and runs
 * it in list mode (`--list --reporter`), so the listing and the run build their leaves the same
 * way. It writes JSON to the path in `PSP_HARNESS_RESULT`: `{ durationMs, shard, projects, leaves }`,
 * where `shard` is the sharding the resolved config or the command line sets. It
 * uses only the public Reporter API.
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
    this.config = null;
    this.suite = null;
    this.startedAt = 0;
  }

  onBegin(config, suite) {
    this.config = config;
    this.suite = suite;
    this.startedAt = Date.now();
  }

  onEnd(result) {
    const target = process.env.PSP_HARNESS_RESULT;
    if (!target || !this.suite) return;
    const durationMs =
      typeof result.duration === 'number' ? result.duration : Date.now() - this.startedAt;
    const leaves = this.suite.allTests().map(leafOf);
    const projects = ((this.config && this.config.projects) || []).map((project) => ({
      name: project.name,
      dependencies: project.dependencies || [],
      teardown: project.teardown || null,
    }));
    const shard = (this.config && this.config.shard) || null;
    fs.writeFileSync(target, JSON.stringify({ durationMs, shard, projects, leaves }, null, 2));
  }

  printsToStdio() {
    return false;
  }
}

module.exports = HarnessReporter;
module.exports.leafOf = leafOf;
