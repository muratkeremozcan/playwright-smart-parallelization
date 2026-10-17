/**
 * The timing check of the end-to-end pipeline (tests/e2e/timing.js): the step times it reads from
 * a job log, and the budgets it holds them to.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { judge, stepTimes } = require('./e2e/timing');

const PREFIX = '[playwright-smart-parallelization]';

test('reads the time each step of the Action logged, under the timestamps of a job log', () => {
  const log = [
    `2026-10-17T12:11:19.8616406Z ${PREFIX} mode balanced: history entry x`,
    `2026-10-17T12:11:19.8620000Z ${PREFIX} the main step took 1.04s`,
    '2026-10-17T12:11:23.3629089Z Post job cleanup.',
    `2026-10-17T12:11:25.6190655Z ${PREFIX} the post step took 2.31s\r`,
    `2026-10-17T12:11:25.6190655Z ${PREFIX} published 9 samples`,
  ].join('\n');
  assert.deepStrictEqual(stepTimes(log), { main: 1.04, post: 2.31 });
  assert.deepStrictEqual(stepTimes(`x ${PREFIX} the finish step took 3s`), { finish: 3 });
  assert.deepStrictEqual(stepTimes('the main step took 1s'), {});
});

test('holds the median shard job to the budget and any one shard job to twice it', () => {
  const shard = (name, main, post) => ({ name, main, post });
  const ok = judge({
    shards: [shard('a', 1, 1), shard('b', 1, 1.5), shard('c', 2, 4)],
    finish: { name: 'f', finish: 2 },
    shardBudget: 3,
    finishBudget: 4,
  });
  assert.deepStrictEqual(ok.problems, []);
  assert.ok(ok.lines.includes('median main and post per shard job: 2.50s, budget 3s'));

  const slow = judge({
    shards: [shard('a', 2, 2), shard('b', 2, 2)],
    finish: null,
    shardBudget: 3,
    finishBudget: 4,
  });
  assert.match(slow.problems.join('\n'), /median 4\.00s in the Action, over the budget of 3s/);

  const outlier = judge({
    shards: [shard('a', 1, 1), shard('b', 1, 1), shard('c', 3, 4)],
    finish: null,
    shardBudget: 3,
    finishBudget: 4,
  });
  assert.deepStrictEqual(outlier.problems, [
    'c spent 7.00s in the Action, over twice the budget of 3s',
  ]);
});

test('a missing time, no shard job or a slow finish fails the check', () => {
  const missing = judge({
    shards: [{ name: 'a', main: 1 }],
    finish: { name: 'f' },
    shardBudget: 3,
    finishBudget: 4,
  });
  assert.deepStrictEqual(missing.problems, [
    'a logged no time for its main and post steps',
    'f logged no time for its step',
  ]);
  assert.deepStrictEqual(
    judge({ shards: [], finish: null, shardBudget: 3, finishBudget: 4 }).problems,
    ['no shard job of this pipeline was found']
  );
  assert.match(
    judge({ shards: [], finish: { name: 'f', finish: 5 }, shardBudget: 3, finishBudget: 4 })
      .problems[1],
    /finish step took 5\.00s, over the budget of 4s/
  );
});
