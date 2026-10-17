'use strict';

const { record, sleep, test, testEvent } = require('./fixtures');

for (const [name, ms] of [
  ['slow', 400],
  ['medium', 200],
  ['quick', 60],
]) {
  test(`plain ${name}`, async ({}, info) => {
    await sleep(ms);
    record('test', info, { ...testEvent(info), status: 'passed' });
  });
}
