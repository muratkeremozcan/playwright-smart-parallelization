'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reduceBlob } = require('../blob');

const SECRET = 'super-secret-value-123';

function blob({ extra = [] } = {}) {
  const events = [
    {
      method: 'onBlobReportMetadata',
      params: {
        version: 2,
        userAgent: 'Playwright/1.58.2 (x64; ubuntu 24.04) node/24.21 CI/1',
        shard: { current: 2, total: 3 },
      },
    },
    {
      method: 'onConfigure',
      params: {
        config: {
          version: '1.58.2',
          workers: 1,
          webServer: { env: { GUARDIAN_INVITE_JWT_SECRET: SECRET } },
        },
      },
    },
    {
      method: 'onProject',
      params: {
        project: {
          name: 'chromium',
          retries: 2,
          repeatEach: 1,
          dependencies: [],
          metadata: { token: SECRET },
          suites: [
            {
              title: 'a.spec.ts',
              entries: [
                {
                  title: 'Outer',
                  entries: [
                    { testId: 'id1', title: 'first', location: { file: 'a.spec.ts' }, retries: 2 },
                    {
                      title: 'Inner',
                      entries: [
                        {
                          testId: 'id2',
                          title: 'second',
                          location: { file: 'a.spec.ts' },
                          retries: 2,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    {
      method: 'onTestBegin',
      params: { testId: 'id1', result: { id: 'r1', retry: 0, workerIndex: 0, startTime: 100 } },
    },
    {
      method: 'onTestEnd',
      params: {
        test: { testId: 'id1', expectedStatus: 'passed' },
        result: { id: 'r1', duration: 50, status: 'failed' },
      },
    },
    {
      method: 'onTestBegin',
      params: { testId: 'id1', result: { id: 'r2', retry: 1, workerIndex: 0, startTime: 200 } },
    },
    {
      method: 'onTestEnd',
      params: {
        test: { testId: 'id1', expectedStatus: 'passed' },
        result: { id: 'r2', duration: 70, status: 'passed' },
      },
    },
    {
      method: 'onTestBegin',
      params: { testId: 'id2', result: { id: 'r3', retry: 0, workerIndex: 0, startTime: 300 } },
    },
    {
      method: 'onTestEnd',
      params: {
        test: { testId: 'id2', expectedStatus: 'passed' },
        result: { id: 'r3', duration: 10, status: 'passed' },
      },
    },
    { method: 'onStdIO', params: { data: SECRET } },
    { method: 'onEnd', params: { result: { status: 'passed', startTime: 90, duration: 400 } } },
    ...extra,
  ];
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

test('reduces versions, the shard, the run window and every attempt of every test', () => {
  const reduced = reduceBlob(blob());
  assert.equal(reduced.playwrightVersion, '1.58.2');
  assert.equal(reduced.node, '24.21');
  assert.deepEqual(reduced.shard, { current: 2, total: 3 });
  assert.equal(reduced.workers, 1);
  assert.deepEqual(reduced.run, { startTime: 90, duration: 400 });
  assert.deepEqual(reduced.projects, [
    { name: 'chromium', retries: 2, repeatEach: 1, dependencies: [] },
  ]);
  const [first, second] = reduced.tests;
  assert.deepEqual(first.titlePath, ['a.spec.ts', 'Outer']);
  assert.deepEqual(second.titlePath, ['a.spec.ts', 'Outer', 'Inner']);
  assert.deepEqual(
    first.attempts.map((a) => [a.retry, a.status, a.duration, a.startTime]),
    [
      [0, 'failed', 50, 100],
      [1, 'passed', 70, 200],
    ]
  );
  assert.equal(first.expectedStatus, 'passed');
});

test('copies no environment value or metadata into the reduced report', () => {
  assert.equal(JSON.stringify(reduceBlob(blob())).includes(SECRET), false);
});

test('rejects a report without its end event and an attempt of an unlisted test', () => {
  assert.throws(() =>
    reduceBlob(
      blob()
        .split('\n')
        .filter((l) => !l.includes('onEnd'))
        .join('\n')
    )
  );
  const stray = [
    {
      method: 'onTestBegin',
      params: { testId: 'zz', result: { id: 'rz', retry: 0, workerIndex: 0, startTime: 1 } },
    },
    {
      method: 'onTestEnd',
      params: {
        test: { testId: 'zz', expectedStatus: 'passed' },
        result: { id: 'rz', duration: 1, status: 'passed' },
      },
    },
  ];
  assert.throws(() => reduceBlob(blob({ extra: stray })), /unlisted test/);
});

test('attempts come out in retry order whatever order their events arrive in', () => {
  const late = blob().split('\n');
  const retryOne = late.findIndex((l) => l.includes('"r2"') && l.includes('onTestBegin'));
  const reordered = [...late];
  // move both events of retry 1 before those of retry 0
  const first = late.findIndex((l) => l.includes('"r1"') && l.includes('onTestBegin'));
  reordered.splice(first, 0, late[retryOne], late[retryOne + 1]);
  reordered.splice(retryOne + 2, 2);
  const reduced = reduceBlob(reordered.join('\n'));
  assert.deepEqual(
    reduced.tests[0].attempts.map((a) => a.retry),
    [0, 1]
  );
});

test('each of the metadata, configuration and end events is required', () => {
  for (const method of ['onBlobReportMetadata', 'onConfigure', 'onEnd']) {
    const without = blob()
      .split('\n')
      .filter((l) => !l.includes(`"${method}"`))
      .join('\n');
    assert.throws(() => reduceBlob(without), /lacks its metadata/, method);
  }
});

test('an attempt that began and never ended is an error, not a dropped attempt', () => {
  const begun = [
    {
      method: 'onTestBegin',
      params: { testId: 'id2', result: { id: 'r9', retry: 1, workerIndex: 0, startTime: 500 } },
    },
  ];
  assert.throws(() => reduceBlob(blob({ extra: begun })), /began but never ended/);
});
