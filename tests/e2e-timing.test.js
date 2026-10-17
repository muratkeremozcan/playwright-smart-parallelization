/**
 * The timing check of the end-to-end pipeline (tests/e2e/timing.js): the step times it reads from
 * a job log, and the budgets it holds them to.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { judge, pipelineJobs, settledPipelineJobs, stepTimes } = require('./e2e/timing');

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
    finish: { name: 'f', finish: 1 },
    shardBudget: 3,
    finishBudget: 4,
  });
  assert.match(slow.problems.join('\n'), /median 4\.00s in the Action, over the budget of 3s/);

  const outlier = judge({
    shards: [shard('a', 1, 1), shard('b', 1, 1), shard('c', 3, 4)],
    finish: { name: 'f', finish: 1 },
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
    ['no shard job of this pipeline was found', 'no finish job of this pipeline was found']
  );
  assert.match(
    judge({ shards: [], finish: { name: 'f', finish: 5 }, shardBudget: 3, finishBudget: 4 })
      .problems[1],
    /finish step took 5\.00s, over the budget of 4s/
  );
});

test("picks the newest execution of each of its own pipeline's jobs, also on a re-run of the assert job alone", () => {
  const job = (name, attempt, conclusion = 'success', extra = {}) => ({
    name,
    run_attempt: attempt,
    conclusion,
    status: 'completed',
    ...extra,
  });
  const jobs = [
    job('leg / test (1, false)', 1),
    job('leg / test (2, false)', 1, 'failure'),
    job('leg / test (2, false)', 2),
    job('leg / warm (1)', 1),
    job('leg / finish', 1),
    job('leg / finish', 2, 'timed_out'),
    job('leg / warm', 1, 'skipped'),
    job('leg / assert', 1, 'failure'),
    job('leg / assert', 2, null, { status: 'in_progress', runner_name: 'r2' }),
    job('other / test (1, false)', 1),
    job('leg / test (3, false)', 1, 'cancelled'),
  ];
  const picked = pipelineJobs(jobs, 'r2');
  assert.deepStrictEqual(
    picked.shards.map((j) => [j.name, j.run_attempt]),
    [
      ['leg / test (1, false)', 1],
      ['leg / test (2, false)', 2],
      ['leg / test (3, false)', 1],
      ['leg / warm (1)', 1],
    ]
  );
  assert.strictEqual(picked.shards[2].conclusion, 'cancelled', 'reports no times');
  assert.deepStrictEqual(
    [picked.finish.run_attempt, picked.finish.conclusion],
    [2, 'timed_out'],
    'never an older execution'
  );
  assert.throws(() => pipelineJobs(jobs, 'nobody'), /no running job of this run has the runner/);
});

test('waits until the jobs API lists every pipeline job as completed, then fails only after the bound', async () => {
  const job = (name, status, extra = {}) => ({
    name: `e2e, x / ${name}`,
    status,
    conclusion: status === 'completed' ? 'success' : null,
    run_attempt: 1,
    runner_name: `runner ${name}`,
    ...extra,
  });
  const assertJob = job('assert', 'in_progress');
  const lagging = [
    job('test (1, false)', 'completed'),
    job('test (2, false)', 'in_progress'),
    job('finish', 'completed'),
  ];
  const settled = [
    job('test (1, false)', 'completed'),
    job('test (2, false)', 'completed'),
    job('finish', 'completed'),
  ];

  let clock = 0;
  const waits = [];
  const wait = async (ms) => {
    waits.push(ms);
    clock += ms;
  };
  const payloads = [lagging, lagging, settled];
  const picked = await settledPipelineJobs({
    fetchJobs: async () => [assertJob, ...payloads.shift()],
    runner: 'runner assert',
    boundMs: 60_000,
    intervalMs: 5_000,
    wait,
    now: () => clock,
  });
  assert.deepStrictEqual(waits, [5_000, 5_000]);
  assert.deepStrictEqual(
    picked.shards.map((j) => [j.name, j.status, j.conclusion]),
    [
      ['e2e, x / test (1, false)', 'completed', 'success'],
      ['e2e, x / test (2, false)', 'completed', 'success'],
    ]
  );
  assert.strictEqual(picked.finish.status, 'completed');

  clock = 0;
  await assert.rejects(
    settledPipelineJobs({
      fetchJobs: async () => [assertJob, ...lagging],
      runner: 'runner assert',
      boundMs: 20_000,
      intervalMs: 5_000,
      wait,
      now: () => clock,
    }),
    /^Error: the jobs API still lists e2e, x \/ test \(2, false\) as in_progress after 20s$/
  );
  assert.strictEqual(clock, 20_000);
});
