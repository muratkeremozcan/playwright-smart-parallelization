'use strict';

/**
 * The operations check of the end-to-end pipeline (`.github/workflows/e2e-pipeline.yml`), run in
 * its assert job. It reads the logs of the pipeline's shard jobs and of its finish job from the
 * jobs API, takes the network operations each step of the Action counted (lib/operations.js), and
 * fails when a count goes over its budget:
 *
 *   node tests/e2e/operations.js SHARDS ENABLED
 *
 * The budgets (`budgets`) come from the Action's own code paths and constants, so a step that
 * starts making an operation its path does not make fails, while the races the Action is built
 * for, a pin two shards save at once and a compare-and-swap that loses, stay within them. A call
 * that threw is a failure of the service: it is reported, and does not count against a budget. It
 * also fails when more than one shard of a job logged that it created the job's pin, since every
 * shard must plan from one. The time each step took (src/index.js: "the main step took 1.23s")
 * goes into the job summary as a report and fails nothing: wall-clock time on shared runners
 * varies too much to gate on.
 *
 * The pipeline's jobs are the jobs of this run whose names start like the name of the job that
 * runs this check, which it finds by its runner (`pipelineJobs`). It reads GH_TOKEN,
 * GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, RUNNER_NAME and GITHUB_STEP_SUMMARY.
 */

const fs = require('node:fs');
const { KINDS, readOperations } = require('../../lib/operations');
const { WAITS } = require('../../lib/pin');
const { attemptsFor } = require('../../lib/store');

const STEP =
  /\[playwright-smart-parallelization\] the (main|post|finish) step took (\d+(?:\.\d+)?)s$/;
/** The line of the main step of the shard that created its job's pin. */
const PINNED = /\[playwright-smart-parallelization\] pinned .+ as psp-pin-/;

/** Whether one job log says its main step created the pin. */
const createdPin = (log) =>
  String(log)
    .split('\n')
    .some((line) => PINNED.test(line));

/** The step times one job log holds: `{ main, post, finish }` in seconds, each or undefined. */
function stepTimes(log) {
  const times = {};
  for (const line of String(log).split('\n')) {
    const found = STEP.exec(line.trimEnd());
    if (found) times[found[1]] = Number(found[2]);
  }
  return times;
}

/** The artifacts the finish step downloads (lib/finish.js PREFIXES). */
const RUN_ARTIFACTS = ['psp-record-', 'psp-start-'];

const none = () => Object.fromEntries(KINDS.map((kind) => [kind, 0]));

/**
 * The most operations of each kind a step may make, from the Action's code paths. `run` is the
 * leg: `shards` its shard count, `enabled` false for a rollback, `artifacts` the run's record and
 * start marker artifacts when this check reads them, which is no fewer than the finish step found,
 * since it ran before, and `jobs` the jobs of the run, which the finish step reads. `step` is what
 * the step's own counts and job say about the path it took: `attempt` of its job, and the `lost`
 * saves and `lookups` of the step.
 *
 * - main (lib/setup.js, lib/pin.js): the pin and the newest history restored and the run's
 *   artifacts listed at once; the pin saved at most once; the start marker uploaded. Only a shard
 *   that found no pin downloads the records of the shards that already ran, at most every record
 *   of the run; only a pin save that lost, because another shard created the pin first, reads it
 *   back after each wait in WAITS; only a re-run asks the run's age.
 * - post (lib/publish.js, lib/store.js): the run record uploaded; at most attemptsFor(shards)
 *   saves. Each lost save, which did not create its key, reads it back with one restore, and may
 *   read the newest entry again; the first read of the newest entry comes before any save. A read
 *   of the newest entry is one restore, or, once the step holds bytes of the history, one lookup
 *   and at most two restores. So restores are at most 1 + 2 lost + lookups, and lookups at most
 *   1 + lost: a save that created its key reads nothing back.
 * - finish (lib/finish.js, lib/summary.js): one listing; each record and start marker of the run
 *   downloaded once, those of every leg, since it lists them all; one jobs API request per page of
 *   100 jobs.
 * - A rollback makes none, except the status record its post step uploads, and the finish step.
 */
function budgets(run, step = {}) {
  const { shards, enabled = true, artifacts = 0, jobs = 0 } = run;
  const { attempt = 1, lost = 0, lookups = 0 } = step;
  const rerun = attempt > 1;
  return {
    main: enabled
      ? {
          ...none(),
          'cache-restore': 2 + (lost ? 1 + WAITS.length : 0),
          'cache-save': 1,
          'artifact-upload': 1,
          'artifact-list': 1,
          'artifact-download': artifacts,
          'api-request': rerun ? 1 : 0,
        }
      : none(),
    post: enabled
      ? {
          ...none(),
          'artifact-upload': 1,
          'cache-save': attemptsFor(shards),
          'cache-lookup': 1 + lost,
          'cache-restore': 1 + 2 * lost + lookups,
        }
      : { ...none(), 'artifact-upload': 1 },
    finish: {
      ...none(),
      'artifact-list': 1,
      'artifact-download': artifacts,
      'api-request': Math.floor(jobs / 100) + 1,
    },
  };
}

/** The problems of one step's counts against its budget. */
function overBudget(name, step, counts, budget) {
  return KINDS.filter((kind) => counts[kind] > budget[kind]).map(
    (kind) =>
      `${name} made ${counts[kind]} ${kind} in its ${step} step, over the budget of ${budget[kind]}`
  );
}

/**
 * The verdict on a pipeline: `{ problems, lines }`. `shards` are `{ name, attempt, operations,
 * times }` with `operations` from `readOperations` and `times` from `stepTimes`, `finish` the same
 * or null, and `run` the leg of `budgets`.
 */
function judge({ shards, finish, run }) {
  const problems = [];
  const lines = [
    '| Job | Step | Seconds | Operations | Failed |',
    '| --- | --- | ---: | --- | ---: |',
  ];
  const row = (name, step, operations, times) => {
    const counts = operations[step];
    const listed = counts
      ? KINDS.filter((kind) => counts[kind])
          .map((kind) => `${kind} ${counts[kind]}`)
          .join(', ') || 'none'
      : 'not logged';
    const seconds = times[step] === undefined ? 'n/a' : times[step].toFixed(2);
    lines.push(
      `| ${name} | ${step} | ${seconds} | ${listed} | ${counts ? counts.failed : 'n/a'} |`
    );
  };
  for (const shard of shards) {
    for (const step of ['main', 'post']) {
      row(shard.name, step, shard.operations, shard.times);
      const counts = shard.operations[step];
      if (!counts) {
        problems.push(`${shard.name} logged no network operations for its ${step} step`);
        continue;
      }
      const budget = budgets(run, {
        attempt: shard.attempt,
        lost: counts.lost,
        lookups: counts['cache-lookup'],
      })[step];
      problems.push(...overBudget(shard.name, step, counts, budget));
    }
  }
  // Every shard of a job plans from one pin, so at most one shard of each job creates it.
  const creators = new Map();
  for (const shard of shards.filter((s) => s.createdPin)) {
    const job = shard.name.slice(shard.name.lastIndexOf(' / ') + 3).split(' ')[0];
    creators.set(job, [...(creators.get(job) || []), shard.name]);
  }
  for (const [job, names] of creators) {
    if (names.length > 1) {
      problems.push(
        `${names.length} shards of job ${job} each created its pin: ${names.join(', ')}`
      );
    }
  }
  if (!shards.length) problems.push('no shard job of this pipeline was found');
  if (!finish) problems.push('no finish job of this pipeline was found');
  else {
    row(finish.name, 'finish', finish.operations, finish.times);
    const counts = finish.operations.finish;
    if (!counts) problems.push(`${finish.name} logged no network operations for its step`);
    else {
      const budget = budgets(run).finish;
      problems.push(...overBudget(finish.name, 'finish', counts, budget));
    }
  }
  return { problems, lines };
}

/**
 * The jobs of the pipeline that runs this check, from every execution of the run: the newest
 * execution of each job name whose name starts like the name of the running job on `runner`, so a
 * re-run of only the assert job still reads the shard and finish jobs it follows. A skipped job
 * never ran; any other newest execution counts, so one that was cancelled or timed out reports
 * no operations instead of an older execution's. Returns `{ shards, finish }`.
 */
function pipelineJobs(jobs, runner) {
  const own = jobs.find((j) => j.runner_name === runner && j.status === 'in_progress');
  if (!own) throw new Error(`no running job of this run has the runner ${runner}`);
  const prefix = own.name.slice(0, own.name.lastIndexOf(' / ') + 3);
  const isShard = (j) => /^(test|warm) \(/.test(j.name.slice(prefix.length));
  const newest = new Map();
  for (const j of jobs) {
    if (!j.name.startsWith(prefix) || j === own || j.conclusion === 'skipped') continue;
    const seen = newest.get(j.name);
    if (!seen || (j.run_attempt || 1) > (seen.run_attempt || 1)) newest.set(j.name, j);
  }
  const picked = [...newest.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    shards: picked.filter(isShard),
    finish: picked.find((j) => j.name === `${prefix}finish`) || null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The picked jobs once every one of them reports completed. The jobs API can list a job as in
 * progress for tens of seconds after its last step ended, and such a job has no conclusion and so
 * no log to read. Polls `fetchJobs` every `intervalMs` and picks from it with `pick`, which returns
 * `{ shards, finish }`, until every picked job is completed, and fails only after `boundMs`,
 * naming the jobs still not completed. Returns the pick and the jobs it was made from.
 */
async function settledJobs({
  fetchJobs,
  pick,
  boundMs = 180_000,
  intervalMs = 5_000,
  wait = sleep,
  now = Date.now,
}) {
  const deadline = now() + boundMs;
  for (;;) {
    const jobs = await fetchJobs();
    const picked = pick(jobs);
    const all = [...picked.shards, ...(picked.finish ? [picked.finish] : [])];
    const open = all.filter((j) => j.status !== 'completed');
    if (!open.length) return { ...picked, jobs };
    if (now() >= deadline) {
      throw new Error(
        `the jobs API still lists ${open.map((j) => `${j.name} as ${j.status}`).join(', ')} ` +
          `after ${boundMs / 1000}s`
      );
    }
    await wait(intervalMs);
  }
}

async function api(env, route, { text = false } = {}) {
  const base = env.GITHUB_API_URL || 'https://api.github.com';
  // A job's log can take a few seconds to appear after the job ends.
  for (const wait of [0, 2, 4, 8, 15]) {
    if (wait) await sleep(wait * 1000);
    const response = await fetch(`${base}${route}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
    });
    if (response.ok) return text ? response.text() : response.json();
    if (response.status !== 404) throw new Error(`${route} answered ${response.status}`);
  }
  throw new Error(`${route} answered 404`);
}

async function main(env = process.env, argv = process.argv.slice(2)) {
  const shardCount = Number(argv[0]);
  if (
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    !['true', 'false'].includes(argv[1]) ||
    argv.length !== 2
  ) {
    throw new Error('usage: node tests/e2e/operations.js SHARDS ENABLED');
  }
  const run = `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const pages = async (route, key) => {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const body = await api(
        env,
        `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`
      );
      items.push(...body[key]);
      if (body[key].length < 100) break;
    }
    return items;
  };
  const fetchJobs = () => pages(`${run}/jobs?filter=all`, 'jobs');
  const picked = await settledJobs({
    fetchJobs,
    pick: (jobs) => pipelineJobs(jobs, env.RUNNER_NAME),
  });
  // A job that did not run to an end has no log to read.
  const read = async (j) => {
    const log = ['success', 'failure'].includes(j.conclusion)
      ? await api(env, `/repos/${env.GITHUB_REPOSITORY}/actions/jobs/${j.id}/logs`, { text: true })
      : '';
    return {
      name: j.name,
      attempt: j.run_attempt || 1,
      operations: readOperations(log),
      times: stepTimes(log),
      createdPin: createdPin(log),
    };
  };
  const shards = [];
  for (const j of picked.shards) shards.push(await read(j));
  const finish = picked.finish ? await read(picked.finish) : null;
  // The finish step lists the newest artifact of each name, and reads every job of the run.
  const artifacts = new Set(
    (await pages(`${run}/artifacts`, 'artifacts'))
      .map((a) => a.name)
      .filter((name) => RUN_ARTIFACTS.some((prefix) => name.startsWith(prefix)))
  ).size;
  const { problems, lines } = judge({
    shards,
    finish,
    run: { shards: shardCount, enabled: argv[1] === 'true', artifacts, jobs: picked.jobs.length },
  });
  for (const line of lines) process.stdout.write(`${line}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### The Action's network operations and step times\n\nThe operations are held to budgets; the seconds are a report.\n\n${lines.join('\n')}\n`
    );
  }
  for (const problem of problems) process.stdout.write(`::error::${problem}\n`);
  if (problems.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { budgets, createdPin, judge, pipelineJobs, settledJobs, stepTimes };
