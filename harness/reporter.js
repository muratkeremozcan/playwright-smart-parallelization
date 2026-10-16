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
const { assertNamedProjects, buildLeaf, serialGroupId, toPosix } = require('./leaves');

const sameLocation = (a, b) => a.file === b.file && a.line === b.line && a.column === b.column;

/**
 * The outermost serial suite of a test. Playwright adds one serial annotation per serial ancestor,
 * outermost first, located at that suite's own call (a helper that builds suites gives siblings one
 * location). The serial ancestors at that location are matched by walking the suite ancestry, and
 * the call fails closed when the match is not exact.
 */
function outermostSerialSuite(test) {
  const serial = test.annotations.filter((a) => a.type === 'serial' && a.location);
  if (serial.length === 0) return null;
  const { location } = serial[0];
  const ancestors = [];
  for (let suite = test.parent; suite; suite = suite.parent) ancestors.unshift(suite);
  const matching = ancestors.filter(
    (suite) => suite.location && sameLocation(suite.location, location)
  );
  const annotated = serial.filter((a) => sameLocation(a.location, location)).length;
  if (matching.length === 0 || matching.length !== annotated) {
    throw new Error(
      `cannot tell which suite of ${test.titlePath().join(' › ')} is serial: ` +
        `${annotated} serial annotations and ${matching.length} suites at one location`
    );
  }
  return matching[0];
}

function leafOf(test) {
  const project = test.parent.project();
  const testDir = project.testDir;
  const [, , specFile, ...titlePath] = test.titlePath();
  const serial = outermostSerialSuite(test);
  const serialGroup = serial
    ? serialGroupId({
        project: project.name,
        specFile,
        suiteTitles: serial.titlePath().slice(3),
        repeatIndex: test.repeatEachIndex,
      })
    : null;
  const leaf = buildLeaf({
    id: test.id,
    project: project.name,
    specFile,
    file: toPosix(path.relative(testDir, test.location.file)),
    titlePath,
    repeatIndex: test.repeatEachIndex,
    serialGroup,
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

/**
 * Leaves of every test, failing closed when two distinct serial suites get one group id or two
 * tests get one key: a collision would let a split group or a dropped test qualify.
 */
function leavesOf(tests) {
  const groups = new Map();
  const keys = new Set();
  return tests.map((test) => {
    const leaf = leafOf(test);
    if (keys.has(leaf.key)) throw new Error(`two tests share the id ${leaf.key} (${leaf.label})`);
    keys.add(leaf.key);
    if (leaf.serialGroup) {
      const suite = outermostSerialSuite(test);
      const known = groups.get(leaf.serialGroup);
      if (known && known !== suite) {
        throw new Error(`two serial suites share the group ${leaf.serialGroup}`);
      }
      groups.set(leaf.serialGroup, suite);
    }
    return leaf;
  });
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
    assertNamedProjects((this.config && this.config.projects) || []);
    const leaves = leavesOf(this.suite.allTests());
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
module.exports.leavesOf = leavesOf;
