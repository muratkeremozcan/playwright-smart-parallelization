'use strict';

/** Builds raw run records with timings chosen by the test, so an expected figure is plain arithmetic. */

const T0 = Date.parse('2026-01-01T00:00:00Z');
const isoAt = (offsetMs) => new Date(T0 + offsetMs).toISOString().replace('.000Z', 'Z');

const SERIAL = { file: 'serial.spec.ts', suite: 'Serial journey' };

/** A test with the durations of its attempts; every attempt but the last failed. */
function makeTest(id, durations, { file = `${id}.spec.ts`, titlePath, status } = {}) {
  const outcome = status || 'passed';
  return {
    id,
    project: 'chromium',
    file,
    titlePath: titlePath || [file, 'Suite'],
    title: id,
    retries: 2,
    expectedStatus: 'passed',
    attempts: durations.map((duration, retry) => ({
      retry,
      status: retry === durations.length - 1 ? outcome : 'failed',
      duration,
      startTime: 0,
      workerIndex: 0,
    })),
  };
}

function step(at, number, name, start, end, conclusion = 'success') {
  return {
    number,
    name,
    status: 'completed',
    conclusion,
    startedAt: at(start),
    completedAt: at(end),
  };
}

/**
 * Shard figures in ms: `queue`, `setup`, `prepare` (test step minus the Playwright run), `server`
 * (Playwright run minus the test span), `after`, and `tests` laid out back to back, `gap` apart.
 */
function makeRecord({
  label = 'a',
  id = 1,
  pair = 1,
  conclusion = 'success',
  shards,
  varsQueue = 2000,
  varsMs = 5000,
  mergeQueue = 3000,
  mergeMs = 60000,
  attempt = 1,
  serialSuites = [],
  fullyParallel = true,
  start = 0,
}) {
  const iso = (offsetMs) => isoAt(start + offsetMs);
  const jobs = [
    {
      id: 100,
      name: 'vars',
      status: 'completed',
      conclusion: 'success',
      createdAt: iso(1000),
      startedAt: iso(1000 + varsQueue),
      completedAt: iso(1000 + varsQueue + varsMs),
      labels: ['ubuntu-latest'],
      runnerGroup: 'GitHub Actions',
      runner: null,
      steps: [],
    },
    {
      id: 101,
      name: 'burn-in',
      status: 'completed',
      conclusion: 'skipped',
      createdAt: iso(1500),
      startedAt: iso(1500),
      completedAt: iso(1400),
      labels: [],
      runnerGroup: null,
      runner: null,
      steps: [],
    },
  ];
  const varsDone = 1000 + varsQueue + varsMs;
  const created = varsDone + 1000;
  const blobShards = [];
  let lastDone = 0;
  shards.forEach((shard, i) => {
    const index = i + 1;
    const started = created + shard.queue;
    const busy = shard.tests.reduce(
      (sum, t) => sum + t.attempts.reduce((x, a) => x + a.duration, 0),
      0
    );
    const attempts = shard.tests.reduce((sum, t) => sum + t.attempts.length, 0);
    const gap = shard.gap || 0;
    const runMs = shard.server + busy + gap * (attempts - 1);
    const setupEnd = started + shard.setup;
    const testEnd = setupEnd + shard.prepare + runMs;
    const done = testEnd + shard.after;
    lastDone = Math.max(lastDone, done);
    jobs.push({
      id: 200 + index,
      name: `pw-e2e (${index}, ${shards.length})`,
      status: 'completed',
      conclusion: shard.conclusion || 'success',
      createdAt: iso(created),
      startedAt: iso(started),
      completedAt: iso(done),
      labels: ['ubuntu-latest'],
      runnerGroup: 'GitHub Actions',
      runner: null,
      steps: shard.stoppedAt
        ? [step(iso, 1, shard.stoppedAt, started, done, 'cancelled')]
        : [
            step(iso, 1, 'Install', started, setupEnd),
            ...(shard.noTestStep
              ? []
              : [step(iso, 2, 'Run suite', setupEnd, testEnd, shard.testStepConclusion)]),
            step(iso, 3, 'Upload', testEnd, done),
          ],
      failureNote: shard.failureNote || null,
    });
    let clock = 1_000_000 + shard.server;
    const tests = shard.tests.map((t) => ({
      ...t,
      attempts: t.attempts.map((a) => {
        const placed = { ...a, startTime: clock };
        clock += a.duration + (shard.gap || 0);
        return placed;
      }),
    }));
    blobShards.push({
      index,
      total: shards.length,
      jobId: 200 + index,
      blob: shard.blobMissing
        ? null
        : {
            playwrightVersion: '1.0.0',
            node: '24.1',
            shard: { current: index, total: shards.length },
            workers: 1,
            projects: [{ name: 'chromium', retries: 2, repeatEach: 1, dependencies: [] }],
            run: { startTime: 1_000_000, duration: runMs },
            tests,
          },
      blobMissing: shard.blobMissing || null,
    });
  });
  const mergeCreated = lastDone + 1000;
  jobs.push({
    id: 300,
    name: 'merge-reports',
    status: 'completed',
    conclusion: 'success',
    createdAt: iso(mergeCreated),
    startedAt: iso(mergeCreated + mergeQueue),
    completedAt: iso(mergeCreated + mergeQueue + mergeMs),
    labels: ['ubuntu-latest'],
    runnerGroup: 'GitHub Actions',
    runner: null,
    steps: [step(iso, 1, 'Merge', mergeCreated + mergeQueue, mergeCreated + mergeQueue + mergeMs)],
  });
  return {
    schema: 1,
    label,
    pair,
    labelNote: 'test',
    repo: { owner: 'o', name: 'r' },
    workflow: '.github/workflows/w.yml',
    testStep: 'Run suite',
    facts: { command: 'npx playwright test', fullyParallel, source: 'test' },
    serialSuites,
    run: {
      id,
      number: id,
      attempt,
      event: 'workflow_dispatch',
      branch: 'b',
      sha: 'abcdef0123456789',
      status: 'completed',
      conclusion,
      createdAt: iso(0),
      startedAt: iso(0),
      updatedAt: iso(mergeCreated + mergeQueue + mergeMs),
      url: `https://example.test/runs/${id}`,
    },
    jobs,
    shards: blobShards,
  };
}

/** Two shards: 3 tests of 10 s and 20 s, setup 100 s, prepare 20 s, server 30 s, after 10 s. */
function standard(overrides = {}) {
  const base = { queue: 2000, setup: 100000, prepare: 20000, server: 30000, after: 10000 };
  return makeRecord({
    shards: [
      { ...base, tests: [makeTest('t1', [10000]), makeTest('t2', [10000])] },
      { ...base, queue: 4000, tests: [makeTest('t3', [20000])] },
    ],
    ...overrides,
  });
}

module.exports = { SERIAL, makeRecord, makeTest, standard };
