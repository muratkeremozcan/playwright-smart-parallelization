'use strict';

/**
 * The timing check of the end-to-end legs: it reads the logs of shard jobs and finish jobs from
 * the jobs API, takes the time each step of the Action logged for itself (src/index.js: "the main
 * step took 1.23s"), and fails when a step grows past its budget. Budgets are seconds.
 *
 *   node tests/e2e/timing.js leg SHARD_BUDGET FINISH_BUDGET LEG_MEDIAN
 *
 * runs in the assert job of one leg (`.github/workflows/e2e-pipeline.yml`). Twice SHARD_BUDGET
 * bounds the main and post steps of every shard job of the leg, and FINISH_BUDGET its finish step.
 * With LEG_MEDIAN true, SHARD_BUDGET also bounds the median over the leg's own shard jobs. The
 * leg's jobs are the jobs of this run whose names start like the name of the job that runs this
 * check, which it finds by its runner (`pipelineJobs`).
 *
 *   node tests/e2e/timing.js run SHARD_BUDGET [EXCLUDED_LEG...]
 *
 * runs once after every leg (`.github/workflows/test.yml`): SHARD_BUDGET bounds the median over
 * every shard job of every leg, except the legs named, which hold their own median (`runJobs`).
 * A few shards of one leg vary too much for a tight median; the pool of every leg does not.
 *
 * Both read GH_TOKEN, GITHUB_API_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID, and the leg mode
 * RUNNER_NAME.
 */

const STEP =
  /\[playwright-smart-parallelization\] the (main|post|finish) step took (\d+(?:\.\d+)?)s$/;

/** The step times one job log holds: `{ main, post, finish }` in seconds, each or undefined. */
function stepTimes(log) {
  const times = {};
  for (const line of String(log).split('\n')) {
    const found = STEP.exec(line.trimEnd());
    if (found) times[found[1]] = Number(found[2]);
  }
  return times;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The verdict on the step times of one leg: `{ problems, lines }`. `shards` are
 * `{ name, main, post }`, `finish` is `{ name, finish }` or null. `holdMedian` false leaves the
 * median to the check over every leg (`judgeRun`).
 */
function judge({ shards, finish, shardBudget, finishBudget, holdMedian = true }) {
  const problems = [];
  const lines = [];
  const totals = [];
  for (const shard of shards) {
    if (shard.main === undefined || shard.post === undefined) {
      problems.push(`${shard.name} logged no time for its main and post steps`);
      continue;
    }
    const total = shard.main + shard.post;
    totals.push(total);
    lines.push(`${shard.name}: main ${shard.main.toFixed(2)}s, post ${shard.post.toFixed(2)}s`);
    if (total > 2 * shardBudget) {
      problems.push(
        `${shard.name} spent ${total.toFixed(2)}s in the Action, over twice the budget of ${shardBudget}s`
      );
    }
  }
  if (!shards.length) problems.push('no shard job of this pipeline was found');
  if (totals.length) {
    const mid = median(totals);
    lines.push(
      holdMedian
        ? `median main and post per shard job: ${mid.toFixed(2)}s, budget ${shardBudget}s`
        : `median main and post per shard job: ${mid.toFixed(2)}s, held over every leg`
    );
    if (holdMedian && mid > shardBudget) {
      problems.push(
        `the shard jobs spent a median ${mid.toFixed(2)}s in the Action, over the budget of ${shardBudget}s`
      );
    }
  }
  if (!finish) problems.push('no finish job of this pipeline was found');
  else {
    if (finish.finish === undefined) problems.push(`${finish.name} logged no time for its step`);
    else {
      lines.push(`${finish.name}: ${finish.finish.toFixed(2)}s, budget ${finishBudget}s`);
      if (finish.finish > finishBudget) {
        problems.push(
          `the finish step took ${finish.finish.toFixed(2)}s, over the budget of ${finishBudget}s`
        );
      }
    }
  }
  return { problems, lines };
}

/** The verdict on the median over the shard jobs of every leg: `{ problems, lines }`. */
function judgeRun({ shards, shardBudget }) {
  const problems = [];
  const totals = [];
  for (const shard of shards) {
    if (shard.main === undefined || shard.post === undefined) {
      problems.push(`${shard.name} logged no time for its main and post steps`);
    } else totals.push(shard.main + shard.post);
  }
  if (!shards.length) problems.push('no shard job of any leg was found');
  const lines = [];
  if (totals.length) {
    const mid = median(totals);
    lines.push(
      `median main and post over ${totals.length} shard jobs of every leg: ${mid.toFixed(2)}s, budget ${shardBudget}s`
    );
    if (mid > shardBudget) {
      problems.push(
        `the shard jobs of every leg spent a median ${mid.toFixed(2)}s in the Action, over the budget of ${shardBudget}s`
      );
    }
  }
  return { problems, lines };
}

/** Every leg in test.yml is named `e2e, ...`; a shard job of one is `<leg> / test (...)` or `warm (...)`. */
const LEG_SHARD = /^(e2e, .+) \/ (?:test|warm) \(/;

/**
 * The shard jobs of every leg of the run but the `excluded` legs: the newest execution of each
 * job name, without skipped jobs, as `pipelineJobs` picks them. Returns `{ shards, finish: null }`.
 */
function runJobs(jobs, excluded = []) {
  const newest = new Map();
  for (const j of jobs) {
    const leg = LEG_SHARD.exec(j.name);
    if (!leg || excluded.includes(leg[1]) || j.conclusion === 'skipped') continue;
    const seen = newest.get(j.name);
    if (!seen || (j.run_attempt || 1) > (seen.run_attempt || 1)) newest.set(j.name, j);
  }
  return {
    shards: [...newest.values()].sort((a, b) => a.name.localeCompare(b.name)),
    finish: null,
  };
}

/**
 * The jobs of the pipeline that runs this check, from every execution of the run: the newest
 * execution of each job name whose name starts like the name of the running job on `runner`, so a
 * re-run of only the assert job still reads the shard and finish jobs it follows. A skipped job
 * never ran; any other newest execution counts, so one that was cancelled or timed out reports
 * no times instead of an older execution's. Returns `{ shards, finish }`.
 */
function pipelineJobs(jobs, runner) {
  const own = jobs.find((j) => j.runner_name === runner && j.status === 'in_progress');
  if (!own) throw new Error(`no running job of this run has the runner ${runner}`);
  const prefix = own.name.slice(0, own.name.lastIndexOf(' / ') + 3);
  const newest = new Map();
  for (const j of jobs) {
    if (!j.name.startsWith(prefix) || j === own || j.conclusion === 'skipped') continue;
    const seen = newest.get(j.name);
    if (!seen || (j.run_attempt || 1) > (seen.run_attempt || 1)) newest.set(j.name, j);
  }
  const picked = [...newest.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    shards: picked.filter((j) => /^(test|warm) \(/.test(j.name.slice(prefix.length))),
    finish: picked.find((j) => j.name === `${prefix}finish`) || null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The picked jobs once every one of them reports completed. The jobs API can list a job as in
 * progress for tens of seconds after its last step ended, and such a job has no conclusion and so
 * no log to time. Polls `fetchJobs` every `intervalMs` and picks from it with `pick`, which returns
 * `{ shards, finish }`, until every picked job is completed, and fails only after `boundMs`,
 * naming the jobs still not completed.
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
    const picked = pick(await fetchJobs());
    const all = [...picked.shards, ...(picked.finish ? [picked.finish] : [])];
    const open = all.filter((j) => j.status !== 'completed');
    if (!open.length) return picked;
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

const USAGE =
  'usage: node tests/e2e/timing.js leg SHARD_BUDGET FINISH_BUDGET LEG_MEDIAN, or run SHARD_BUDGET [EXCLUDED_LEG...]';

/** The command line: `{ mode, shardBudget, finishBudget, holdMedian, excluded }`. */
function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const shardBudget = Number(rest[0]);
  if (!(shardBudget > 0)) throw new Error(USAGE);
  if (mode === 'run') return { mode, shardBudget, excluded: rest.slice(1) };
  const finishBudget = Number(rest[1]);
  if (
    mode !== 'leg' ||
    !(finishBudget > 0) ||
    !['true', 'false'].includes(rest[2]) ||
    rest.length !== 3
  ) {
    throw new Error(USAGE);
  }
  return { mode, shardBudget, finishBudget, holdMedian: rest[2] === 'true' };
}

async function main(env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const run = `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const fetchJobs = async () => {
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const body = await api(env, `${run}/jobs?filter=all&per_page=100&page=${page}`);
      jobs.push(...body.jobs);
      if (body.jobs.length < 100) break;
    }
    return jobs;
  };
  const picked = await settledJobs({
    fetchJobs,
    pick:
      args.mode === 'run'
        ? (jobs) => runJobs(jobs, args.excluded)
        : (jobs) => pipelineJobs(jobs, env.RUNNER_NAME),
  });
  // A job that did not run to an end has no log to time.
  const logOf = async (j) => ({
    name: j.name,
    ...(['success', 'failure'].includes(j.conclusion)
      ? stepTimes(
          await api(env, `/repos/${env.GITHUB_REPOSITORY}/actions/jobs/${j.id}/logs`, {
            text: true,
          })
        )
      : {}),
  });
  const shards = [];
  for (const j of picked.shards) shards.push(await logOf(j));
  const finish = picked.finish ? await logOf(picked.finish) : null;
  const { problems, lines } =
    args.mode === 'run'
      ? judgeRun({ shards, shardBudget: args.shardBudget })
      : judge({ shards, finish, ...args });
  for (const line of lines) process.stdout.write(`${line}\n`);
  for (const problem of problems) process.stdout.write(`::error::${problem}\n`);
  if (problems.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { judge, judgeRun, parseArgs, pipelineJobs, runJobs, settledJobs, stepTimes };
