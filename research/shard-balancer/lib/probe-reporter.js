'use strict';

/**
 * Playwright reporter for the internals rows. In `onBegin` it writes, for every test, what the
 * public reporter API shows (`publicView`: the documented fields of the test and of each parent
 * suite) next to the two internal fields the engines read (`internal`: `_parallelMode` of each
 * parent suite and `_locks` of the test), as JSON to the file named by `PSP_PROBE_OUT`. A row then
 * compares the public views of two variants of a file that differ only in a mode or a lock.
 */

const fs = require('node:fs');
const path = require('node:path');

const location = (loc) =>
  loc ? { file: path.basename(loc.file), line: loc.line, column: loc.column } : null;

function publicSuite(suite) {
  return { title: suite.title, type: suite.type, location: location(suite.location) };
}

function publicTest(test) {
  const parents = [];
  for (let suite = test.parent; suite; suite = suite.parent) parents.push(publicSuite(suite));
  return {
    title: test.title,
    titlePath: test.titlePath(),
    location: location(test.location),
    annotations: test.annotations.map((a) => ({
      type: a.type,
      description: a.description,
      location: location(a.location),
    })),
    tags: test.tags,
    expectedStatus: test.expectedStatus,
    retries: test.retries,
    timeout: test.timeout,
    repeatEachIndex: test.repeatEachIndex,
    parents,
  };
}

function internalOf(test) {
  const modes = [];
  for (let suite = test.parent; suite; suite = suite.parent)
    modes.push(suite._parallelMode === undefined ? null : suite._parallelMode);
  return { parallelModes: modes, locks: Array.isArray(test._locks) ? test._locks : null };
}

class ProbeReporter {
  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    const tests = suite.allTests().map((test) => ({
      project: test.parent.project().name,
      key: test.titlePath().slice(2).join(' › '),
      publicView: publicTest(test),
      internal: internalOf(test),
    }));
    fs.writeFileSync(
      process.env.PSP_PROBE_OUT,
      JSON.stringify({ fullyParallel: config.fullyParallel, tests })
    );
  }
}

module.exports = ProbeReporter;
