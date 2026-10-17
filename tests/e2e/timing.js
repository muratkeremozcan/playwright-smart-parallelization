'use strict';

/**
 * The timing check of the end-to-end pipeline (`.github/workflows/e2e-pipeline.yml`), run in its
 * assert job: it reads the logs of the pipeline's shard jobs and of its finish job from the jobs
 * API, takes the time each step of the Action logged for itself (src/index.js: "the main step
 * took 1.23s"), and fails when a step grows past its budget:
 *
 *   node tests/e2e/timing.js SHARD_BUDGET FINISH_BUDGET
 *
 * SHARD_BUDGET bounds the median over the shard jobs of the main and post steps together, and
 * twice it bounds every shard job, so one slow runner passes and a slower Action does not.
 * FINISH_BUDGET bounds the finish step. Both are seconds. The pipeline's jobs are the jobs of
 * this run whose names start like the name of the job that runs this check, which it finds by
 * its runner (`pipelineJobs`). It reads GH_TOKEN, GITHUB_API_URL, GITHUB_REPOSITORY,
 * GITHUB_RUN_ID and RUNNER_NAME.
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
 * The verdict on the step times of a pipeline: `{ problems, lines }`. `shards` are
 * `{ name, main, post }`, `finish` is `{ name, finish }` or null.
 */
function judge({ shards, finish, shardBudget, finishBudget }) {
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
    lines.push(`median main and post per shard job: ${mid.toFixed(2)}s, budget ${shardBudget}s`);
    if (mid > shardBudget) {
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

/**
 * The jobs of the pipeline that runs this check, from every execution of the run: the newest
 * execution of each job name whose name starts like the name of the running job on `runner`, so a
 * re-run of only the assert job still reads the shard and finish jobs it follows.
 * Returns `{ shards, finish }`; a job that was skipped or cancelled left no times.
 */
function pipelineJobs(jobs, runner) {
  const own = jobs.find((j) => j.runner_name === runner && j.status === 'in_progress');
  if (!own) throw new Error(`no running job of this run has the runner ${runner}`);
  const prefix = own.name.slice(0, own.name.lastIndexOf(' / ') + 3);
  const newest = new Map();
  for (const j of jobs) {
    if (!j.name.startsWith(prefix) || !['success', 'failure'].includes(j.conclusion)) continue;
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

async function main(env = process.env) {
  const [shardBudget, finishBudget] = process.argv.slice(2).map(Number);
  if (!(shardBudget > 0) || !(finishBudget > 0)) {
    throw new Error('usage: node tests/e2e/timing.js SHARD_BUDGET FINISH_BUDGET');
  }
  const run = `/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api(env, `${run}/jobs?filter=all&per_page=100&page=${page}`);
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) break;
  }
  const picked = pipelineJobs(jobs, env.RUNNER_NAME);
  const logOf = async (j) => ({
    name: j.name,
    ...stepTimes(
      await api(env, `/repos/${env.GITHUB_REPOSITORY}/actions/jobs/${j.id}/logs`, { text: true })
    ),
  });
  const shards = [];
  for (const j of picked.shards) shards.push(await logOf(j));
  const finish = picked.finish ? await logOf(picked.finish) : null;
  const { problems, lines } = judge({ shards, finish, shardBudget, finishBudget });
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

module.exports = { judge, pipelineJobs, stepTimes };
