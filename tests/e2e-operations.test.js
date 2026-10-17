/**
 * The operations check of the end-to-end pipeline (tests/e2e/operations.js): the budgets it holds
 * the Action's network operations to, the jobs it reads, and its wait for the jobs API.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { KINDS, operationCounter } = require('../lib/operations');
const { WAITS } = require('../lib/pin');
const { attemptsFor } = require('../lib/store');
const {
  budgets,
  createdPin,
  judge,
  pipelineJobs,
  settledJobs,
  stepTimes,
} = require('./e2e/operations');

const PREFIX = '[playwright-smart-parallelization]';

/** A job log with the lines the Action's steps end with. */
const log = (steps) => {
  const lines = [];
  for (const [step, counts] of Object.entries(steps)) {
    const ops = operationCounter();
    const line = ops
      .line(step)
      .replace(/(\S+) 0/g, (all, kind) => (kind in counts ? `${kind} ${counts[kind]}` : all))
      .replace(/failed 0; lost 0$/, `failed ${counts.failed || 0}; lost ${counts.lost || 0}`);
    lines.push(`2026-10-17T12:00:00.0000000Z ${PREFIX} ${line}`);
    lines.push(`2026-10-17T12:00:00.0000000Z ${PREFIX} the ${step} step took 1.50s`);
  }
  return lines.join('\n');
};

test('reads the times each step of the Action logged, under the timestamps of a job log', () => {
  const text = [
    `2026-10-17T12:11:19.8620000Z ${PREFIX} the main step took 1.04s`,
    `2026-10-17T12:11:25.6190655Z ${PREFIX} the post step took 2.31s\r`,
  ].join('\n');
  assert.deepStrictEqual(stepTimes(text), { main: 1.04, post: 2.31 });
  assert.deepStrictEqual(stepTimes('the main step took 1s'), {});
});

const MAIN = { 'cache-restore': 2, 'cache-save': 1, 'artifact-upload': 1, 'artifact-list': 1 };
const POST = { 'artifact-upload': 1, 'cache-restore': 1, 'cache-save': 1 };
const FINISH = { 'artifact-list': 1, 'artifact-download': 6, 'api-request': 1 };
const RUN = { shards: 3, artifacts: 6, jobs: 40 };

const pipeline = (main = MAIN, post = POST, finish = FINISH) => {
  const { readOperations } = require('../lib/operations');
  const shard = (name) => {
    const text = log({ main, post });
    return { name, operations: readOperations(text), times: stepTimes(text) };
  };
  const text = log({ finish });
  return {
    shards: [shard('leg / test (1, false)'), shard('leg / test (2, false)')],
    finish: { name: 'leg / finish', operations: readOperations(text), times: stepTimes(text) },
  };
};

test('a pipeline whose steps keep to their code paths passes, and the times are only reported', () => {
  const { problems, lines } = judge({ ...pipeline(), run: RUN });
  assert.deepStrictEqual(problems, []);
  assert.ok(
    lines.includes(
      '| leg / test (1, false) | main | 1.50 | cache-restore 2, cache-save 1, artifact-list 1, artifact-upload 1 | 0 |'
    )
  );
  assert.ok(
    lines.includes(
      '| leg / finish | finish | 1.50 | artifact-list 1, artifact-download 6, api-request 1 | 0 |'
    )
  );
});

test('an operation a step does not make on its path fails, whatever the time', () => {
  const extra = judge({
    ...pipeline({ ...MAIN, 'cache-restore': 3 }, { ...POST, 'artifact-download': 1 }),
    run: RUN,
  });
  assert.deepStrictEqual(extra.problems, [
    'leg / test (1, false) made 3 cache-restore in its main step, over the budget of 2',
    'leg / test (1, false) made 1 artifact-download in its post step, over the budget of 0',
    'leg / test (2, false) made 3 cache-restore in its main step, over the budget of 2',
    'leg / test (2, false) made 1 artifact-download in its post step, over the budget of 0',
  ]);
  const finish = judge({
    ...pipeline(MAIN, POST, { ...FINISH, 'artifact-download': 7 }),
    run: RUN,
  });
  assert.deepStrictEqual(finish.problems, [
    'leg / finish made 7 artifact-download in its finish step, over the budget of 6',
  ]);
});

test('the races the Action is built for stay within budget, and failed calls are only reported', () => {
  // Lost the pin race: the pin save created nothing, and the pin was read again after every wait.
  const most = attemptsFor(3);
  const raced = judge({
    ...pipeline(
      { ...MAIN, 'cache-restore': 3 + WAITS.length, lost: 1 },
      // Two saves lost: each read its key back and the newest entry again.
      { ...POST, 'cache-save': 3, lost: 2, 'cache-restore': 1 + 2 * 2 }
    ),
    run: RUN,
  });
  assert.deepStrictEqual(raced.problems, []);
  const spent = judge({
    ...pipeline(MAIN, { ...POST, 'cache-save': most, lost: most, 'cache-restore': 1 + 2 * most }),
    run: RUN,
  });
  assert.deepStrictEqual(
    spent.problems,
    [],
    'the attempts ran out, so the last save read back too'
  );
  // A duplicate publisher: its only save lost, it read the winner back, and that held its samples.
  const duplicate = judge({
    ...pipeline(MAIN, { ...POST, lost: 1, 'cache-restore': 2 }),
    run: RUN,
  });
  assert.deepStrictEqual(duplicate.problems, []);
  // Restores before the step held any bytes, then lookups once it did.
  const mixed = judge({
    ...pipeline(MAIN, { ...POST, 'cache-save': 4, lost: 3, 'cache-lookup': 1, 'cache-restore': 6 }),
    run: RUN,
  });
  assert.deepStrictEqual(mixed.problems, []);
  const over = judge({ ...pipeline(MAIN, { ...POST, 'cache-save': most + 1 }), run: RUN });
  assert.match(
    over.problems[0],
    new RegExp(`made ${most + 1} cache-save in its post step, over the budget of ${most}`)
  );
});

test('on the uncontended path one more operation than the path makes fails', () => {
  const problems = (main, post) => judge({ ...pipeline(main, post), run: RUN }).problems[0];
  // A save that created its key, read back anyway.
  assert.match(
    problems(MAIN, { ...POST, 'cache-restore': 2 }),
    /made 2 cache-restore in its post step, over the budget of 1$/
  );
  // With the pin's bytes: one lookup, and at most two restores of the newest entry.
  assert.strictEqual(problems(MAIN, { ...POST, 'cache-lookup': 1, 'cache-restore': 2 }), undefined);
  assert.match(
    problems(MAIN, { ...POST, 'cache-lookup': 2 }),
    /made 2 cache-lookup in its post step, over the budget of 1$/
  );
  // The pin read again although its save never lost, a second save, a second listing, and the
  // run's age asked on a first attempt.
  assert.match(
    problems({ ...MAIN, 'cache-restore': 3 }),
    /made 3 cache-restore in its main step, over the budget of 2$/
  );
  assert.match(
    problems({ ...MAIN, 'cache-save': 2 }),
    /made 2 cache-save in its main step, over the budget of 1$/
  );
  assert.match(
    problems({ ...MAIN, 'artifact-find': 1 }),
    /made 1 artifact-find in its main step, over the budget of 0$/
  );
  assert.match(
    problems({ ...MAIN, 'artifact-list': 2 }),
    /made 2 artifact-list in its main step, over the budget of 1$/
  );
  assert.match(
    problems({ ...MAIN, 'api-request': 1 }),
    /made 1 api-request in its main step, over the budget of 0$/
  );
  // A shard that found no pin downloads the records of the shards that already ran, and a
  // re-run asks the run's age.
  const rerun = pipeline({ ...MAIN, 'artifact-download': RUN.artifacts, 'api-request': 1 });
  for (const shard of rerun.shards) shard.attempt = 2;
  assert.deepStrictEqual(judge({ ...rerun, run: RUN }).problems, []);
});

test('a rollback makes no network operations but the status record of its post step', () => {
  const rollback = { ...RUN, enabled: false };
  const disabled = pipeline({}, { 'artifact-upload': 1 });
  assert.deepStrictEqual(judge({ ...disabled, run: rollback }).problems, []);
  const leaked = pipeline({ 'cache-restore': 1 }, { 'artifact-upload': 1, 'cache-save': 1 });
  assert.deepStrictEqual(judge({ ...leaked, run: rollback }).problems.slice(0, 2), [
    'leg / test (1, false) made 1 cache-restore in its main step, over the budget of 0',
    'leg / test (1, false) made 1 cache-save in its post step, over the budget of 0',
  ]);
});

test('a step that logged no operations, or a missing finish job, fails', () => {
  const { shards } = pipeline();
  const silent = judge({
    shards: [{ name: 'leg / test (1, false)', operations: {}, times: {} }, shards[1]],
    finish: null,
    run: RUN,
  });
  assert.deepStrictEqual(silent.problems, [
    'leg / test (1, false) logged no network operations for its main step',
    'leg / test (1, false) logged no network operations for its post step',
    'no finish job of this pipeline was found',
  ]);
  assert.deepStrictEqual(judge({ shards: [], finish: pipeline().finish, run: RUN }).problems, [
    'no shard job of this pipeline was found',
  ]);
});

test('the finish budget follows the run: every record and start marker once, a page per 100 jobs', () => {
  assert.strictEqual(
    budgets({ shards: 8, artifacts: 30, jobs: 99 }).finish['artifact-download'],
    30
  );
  assert.strictEqual(budgets({ shards: 8, artifacts: 30, jobs: 99 }).finish['api-request'], 1);
  assert.strictEqual(budgets({ shards: 8, artifacts: 30, jobs: 100 }).finish['api-request'], 2);
  assert.strictEqual(budgets({ shards: 8 }).post['cache-save'], attemptsFor(8));
  assert.strictEqual(budgets({ shards: 8 }).post['cache-restore'], 1);
  assert.strictEqual(budgets({ shards: 8 }, { lost: 3, lookups: 1 }).post['cache-restore'], 8);
  assert.strictEqual(budgets({ shards: 8 }, { lost: 3 }).post['cache-lookup'], 4);
  for (const step of ['main', 'post', 'finish']) {
    for (const kind of KINDS) assert.ok(kind in budgets({ shards: 1 })[step], `${step} ${kind}`);
  }
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
  const picked = await settledJobs({
    fetchJobs: async () => [assertJob, ...payloads.shift()],
    pick: (jobs) => pipelineJobs(jobs, 'runner assert'),
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
    settledJobs({
      fetchJobs: async () => [assertJob, ...lagging],
      pick: (jobs) => pipelineJobs(jobs, 'runner assert'),
      boundMs: 20_000,
      intervalMs: 5_000,
      wait,
      now: () => clock,
    }),
    /^Error: the jobs API still lists e2e, x \/ test \(2, false\) as in_progress after 20s$/
  );
  assert.strictEqual(clock, 20_000);
});

test('at most one shard of a job may create its pin', () => {
  const line = `2026-10-17T12:00:00.0000000Z ${PREFIX} pinned psp-history-v2-k-1-1 as psp-pin-v2-k-test-7`;
  assert.strictEqual(createdPin(line), true);
  assert.strictEqual(createdPin(`${PREFIX} read the pin psp-pin-v2-k-test-7`), false);
  const run = pipeline();
  run.shards[0].createdPin = true;
  assert.deepStrictEqual(judge({ ...run, run: RUN }).problems, []);
  run.shards[1].createdPin = true;
  assert.deepStrictEqual(judge({ ...run, run: RUN }).problems, [
    '2 shards of job test each created its pin: leg / test (1, false), leg / test (2, false)',
  ]);
});
