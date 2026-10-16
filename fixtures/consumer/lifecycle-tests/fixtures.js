'use strict';

const fs = require('node:fs');
const base = require('@playwright/test');

/** Appends one lifecycle event to `PSP_LIFECYCLE_LOG`, tagged with the shard and the worker. */
function record(type, info, extra = {}) {
  const file = process.env.PSP_LIFECYCLE_LOG;
  if (!file) return;
  const event = {
    type,
    shard: process.env.PSP_LIFECYCLE_SHARD || '',
    pid: process.pid,
    worker: info.workerIndex,
    parallel: info.parallelIndex,
    project: info.project.name,
    ...extra,
  };
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const test = base.test.extend({
  // Set up once per worker process and cleaned up when the worker stops, including a worker that
  // Playwright replaces after a failure.
  workerResource: [
    async ({}, use, workerInfo) => {
      record('worker-setup', workerInfo);
      await use({ worker: workerInfo.workerIndex });
      record('worker-cleanup', workerInfo);
    },
    { scope: 'worker', auto: true },
  ],
});

/** The identity of the running test, for an event. */
function testEvent(info) {
  return {
    file: info.file.split(/[\\/]/).pop(),
    title: info.titlePath.slice(1).join(' › '),
    repeat: info.repeatEachIndex,
    retry: info.retry,
  };
}

module.exports = { expect: base.expect, record, sleep, test, testEvent };
