'use strict';

/**
 * Reduces one Playwright blob report (`report.jsonl`) to the facts a measurement needs: versions,
 * the shard, the run window and one record per test with every attempt. The blob carries the whole
 * process environment of the web server, secrets included, so nothing is copied wholesale: only the
 * fields read below leave this function.
 */

function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    events.push(JSON.parse(line));
  }
  return events;
}

/** Walks the suite entries of a project; a test entry carries `testId`, a suite entry `entries`. */
function collectTests(entries, titlePath, project, out) {
  for (const entry of entries) {
    if (entry.testId !== undefined) {
      out.set(entry.testId, {
        id: entry.testId,
        project,
        file: entry.location.file,
        titlePath,
        title: entry.title,
        retries: entry.retries,
        // a copy made by --repeat-each is its own atomic unit; absent in reports before S6
        ...(entry.repeatEachIndex ? { repeatEachIndex: entry.repeatEachIndex } : {}),
        attempts: [],
      });
    } else {
      collectTests(entry.entries || [], [...titlePath, entry.title], project, out);
    }
  }
}

function reduceBlob(text) {
  const events = parseJsonl(text);
  const find = (method) => events.find((event) => event.method === method);
  const metadata = find('onBlobReportMetadata');
  const configure = find('onConfigure');
  const end = find('onEnd');
  if (!metadata || !configure || !end) {
    throw new Error('blob report lacks its metadata, configuration or end event');
  }
  const tests = new Map();
  const projects = [];
  for (const event of events) {
    if (event.method !== 'onProject') continue;
    const project = event.params.project;
    projects.push({
      name: project.name,
      retries: project.retries,
      repeatEach: project.repeatEach,
      dependencies: project.dependencies,
    });
    for (const suite of project.suites) {
      collectTests(suite.entries || [], [suite.title], project.name, tests);
    }
  }
  const begun = new Map();
  for (const event of events) {
    if (event.method === 'onTestBegin') {
      const { testId, result } = event.params;
      begun.set(result.id, {
        testId,
        retry: result.retry,
        workerIndex: result.workerIndex,
        startTime: result.startTime,
      });
    } else if (event.method === 'onTestEnd') {
      const { test, result } = event.params;
      const start = begun.get(result.id);
      if (!start) throw new Error(`attempt ${result.id} ended without beginning`);
      const record = tests.get(test.testId);
      if (!record) throw new Error(`attempt of unlisted test ${test.testId}`);
      record.expectedStatus = test.expectedStatus;
      record.attempts.push({
        retry: start.retry,
        status: result.status,
        duration: result.duration,
        startTime: start.startTime,
        workerIndex: start.workerIndex,
      });
    }
  }
  const ended = new Set(
    events.filter((event) => event.method === 'onTestEnd').map((event) => event.params.result.id)
  );
  for (const id of begun.keys()) {
    if (!ended.has(id)) throw new Error(`attempt ${id} began but never ended`);
  }
  const userAgent = metadata.params.userAgent;
  const node = /\bnode\/(\S+)/.exec(userAgent);
  return {
    playwrightVersion: configure.params.config.version,
    node: node ? node[1] : null,
    shard: metadata.params.shard,
    workers: configure.params.config.workers,
    projects,
    run: { startTime: end.params.result.startTime, duration: end.params.result.duration },
    tests: [...tests.values()].map((test) => ({
      ...test,
      attempts: test.attempts.sort((a, b) => a.retry - b.retry),
    })),
  };
}

module.exports = { reduceBlob };
