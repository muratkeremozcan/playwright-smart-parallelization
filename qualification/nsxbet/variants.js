'use strict';

/**
 * Copies of the consumer fixture with one deliberate change each, for the proofs that need a
 * test the fixture does not have: a test whose duration changes between runs and that fails in
 * one of them, and renamed or new tests.
 */

const { copyProject } = require('./drive');

const GREEN = `'use strict';

const { test, request } = require('@playwright/test');
const { sleep } = require('./support');

test('volatile step', async ({}, testInfo) => {
  await testInfo.attach('note', { body: 'recorded' });
  const api = await request.newContext();
  await api.tracing.start();
  if (process.env.PSP_CANCEL_AFTER_MS) {
    setTimeout(() => process.kill(process.ppid, 'SIGINT'), Number(process.env.PSP_CANCEL_AFTER_MS));
  }
  try {
    await sleep(1000);
  } finally {
    await api.tracing.stop({ path: testInfo.outputPath('api-trace.zip') });
  }
});
`;

const RED = `'use strict';

const { test, request } = require('@playwright/test');

test('volatile step', async ({}, testInfo) => {
  await testInfo.attach('note', { body: 'recorded' });
  const api = await request.newContext();
  await api.tracing.start();
  try {
    throw new Error('the volatile step failed at once');
  } finally {
    await api.tracing.stop({ path: testInfo.outputPath('api-trace.zip') });
  }
});
`;

const NEW_FEATURE = `'use strict';

const { test, expect } = require('@playwright/test');
const { sleep } = require('./support');

test.describe('wishlist', () => {
  test('adds a product', async () => {
    await sleep(120);
    expect(1).toBe(1);
  });

  test('shares the list', async () => {
    await sleep(90);
    expect(2).toBe(2);
  });
});
`;

const VOLATILE_ID = 'volatile.spec.js::volatile step';

/** The fixture plus a passing test that sleeps for a second. */
function greenProject(ctx) {
  return ctx.once('variant:green', () =>
    copyProject(ctx.cwd, ctx.dir('variant-green'), { 'tests/volatile.spec.js': GREEN })
  );
}

/** The fixture plus the same test, failing at once. */
function redProject(ctx) {
  return ctx.once('variant:red', () =>
    copyProject(ctx.cwd, ctx.dir('variant-red'), { 'tests/volatile.spec.js': RED })
  );
}

/** The fixture with one test renamed and a new file of two tests. */
function renamedProject(ctx) {
  return ctx.once('variant:renamed', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const cart = fs.readFileSync(path.join(ctx.cwd, 'tests', 'cart.spec.js'), 'utf8');
    return copyProject(ctx.cwd, ctx.dir('variant-renamed'), {
      'tests/cart.spec.js': cart.replace("'adds an item'", "'adds one item'"),
      'tests/wishlist.spec.js': NEW_FEATURE,
    });
  });
}

/**
 * The failing variant run through the engine, with the green variant's native run as its history.
 * The run keeps JSON and blob reports and a separate output directory per shard.
 */
function redRun(ctx) {
  const cwd = redProject(ctx);
  const green = ctx.baseline({ name: 'volatile-green', cwd: greenProject(ctx) });
  const red = ctx.engineRun({
    name: 'volatile-red',
    cwd,
    flow: 'merged',
    shards: 2,
    timing: green.history.timing,
    reports: { blob: true, output: true },
  });
  return { cwd, green, red };
}

module.exports = { VOLATILE_ID, greenProject, redProject, redRun, renamedProject };
