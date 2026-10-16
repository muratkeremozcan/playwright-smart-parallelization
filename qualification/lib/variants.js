'use strict';

/**
 * Copies of the consumer fixture with one deliberate change each, for the proofs that need a
 * test the fixture does not have: a test whose duration changes between runs and that fails in
 * one of them, renamed or new tests, and suites with titles that are hard to tell apart. Each
 * builder takes the collection context, which makes the copy with `ctx.copy(name, edits)`.
 */

const fs = require('node:fs');
const path = require('node:path');

// The volatile test lasts `PSP_VOLATILE_MS` ms (one second by default) in the green variant, and
// fails after `PSP_FAIL_AFTER_MS` ms (at once by default) in the red one.
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
    await sleep(Number(process.env.PSP_VOLATILE_MS || 1000));
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
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.PSP_FAIL_AFTER_MS || 0)));
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

const PREFIX = `'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

test('group', async () => {
  await sleep(100);
});

test.describe('group', () => {
  test('child', async () => {
    await sleep(100);
  });
});
`;

const SIBLINGS = `'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

// One function registers two sibling suites, so their tests share a location and a test title.
function register() {
  test.describe.configure({ mode: 'serial' });
  test('first', async () => {
    await sleep(80);
  });
  test('second', async () => {
    await sleep(80);
  });
}

test.describe('alpha', register);
test.describe('beta', register);
`;

/** The fixture plus a passing test that sleeps for a second. */
function greenProject(ctx) {
  return ctx.once('variant:green', () =>
    ctx.copy('variant-green', { 'tests/volatile.spec.js': GREEN })
  );
}

/** The fixture plus the same test, failing at once. */
function redProject(ctx) {
  return ctx.once('variant:red', () => ctx.copy('variant-red', { 'tests/volatile.spec.js': RED }));
}

/**
 * The fixture with its spec files replaced by one file in which a function registers two sibling
 * serial suites: four tests, two groups, and tests of both suites share a location and a title.
 */
function siblingsProject(ctx) {
  return ctx.once('variant:siblings', () =>
    ctx.copy('variant-siblings', onlySpec(ctx, 'siblings.spec.js', SIBLINGS))
  );
}

/** Edits that delete every spec file of the fixture and add one. */
function onlySpec(ctx, name, content) {
  const edits = { [`tests/${name}`]: content };
  for (const file of fs.readdirSync(path.join(ctx.cwd, 'tests'))) {
    if (file.endsWith('.spec.js') && file !== name) edits[`tests/${file}`] = null;
  }
  return edits;
}

/**
 * The fixture with its spec files replaced by one file in which a test and a describe block share
 * a title, so the test-list line of the test selects the tests of the block too.
 */
function prefixProject(ctx) {
  return ctx.once('variant:prefix', () => {
    return ctx.copy('variant-prefix', onlySpec(ctx, 'prefix.spec.js', PREFIX));
  });
}

/** The fixture with one test renamed and a new file of two tests. */
function renamedProject(ctx) {
  return ctx.once('variant:renamed', () => {
    const cart = fs.readFileSync(path.join(ctx.cwd, 'tests', 'cart.spec.js'), 'utf8');
    return ctx.copy('variant-renamed', {
      'tests/cart.spec.js': cart.replace("'adds an item'", "'adds one item'"),
      'tests/wishlist.spec.js': NEW_FEATURE,
    });
  });
}

const MIXED = `'use strict';

const { defineConfig } = require('@playwright/test');

// Only the chromium project depends on setup; the api project runs the other specs on its own.
module.exports = defineConfig({
  testDir: './tests',
  retries: 2,
  reporter: 'list',
  projects: [
    { name: 'setup', testMatch: /global\\.setup\\.js/, teardown: 'teardown' },
    { name: 'teardown', testMatch: /global\\.teardown\\.js/ },
    { name: 'chromium', testMatch: /(cart|checkout)\\.spec\\.js/, dependencies: ['setup'] },
    { name: 'api', testMatch: /.*\\.spec\\.js/, testIgnore: /(cart|checkout)\\.spec\\.js/ },
  ],
});
`;

/**
 * The fixture with a config in which one project depends on setup and teardown and another does
 * not, so a shard can hold tests that need no setup.
 */
function mixedProject(ctx) {
  return ctx.once('variant:mixed', () =>
    ctx.copy('variant-mixed', { 'playwright.config.js': MIXED })
  );
}

module.exports = {
  greenProject,
  mixedProject,
  prefixProject,
  redProject,
  renamedProject,
  siblingsProject,
};
