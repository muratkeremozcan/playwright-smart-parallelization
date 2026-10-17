'use strict';

const { expect, record, sleep, test, testEvent } = require('./fixtures');

// A default-mode suite whose beforeAll and afterAll hold state its tests share.
test.describe('shared hooks', () => {
  let opened = 0;

  test.beforeAll(async ({}, info) => {
    opened++;
    record('before-all', info, { file: 'shared-hooks.spec.js', repeat: info.repeatEachIndex });
  });

  test.afterAll(async ({}, info) => {
    record('after-all', info, { file: 'shared-hooks.spec.js', repeat: info.repeatEachIndex });
  });

  for (const name of ['reads', 'writes', 'lists']) {
    test(name, async ({}, info) => {
      await sleep(30);
      expect(opened).toBeGreaterThan(0);
      record('test', info, { ...testEvent(info), status: 'passed' });
    });
  }
});
