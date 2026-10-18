'use strict';

/**
 * The job summary of the finish action: predicted and measured time per shard, the slowest shard,
 * the spread and the imbalance, and a simulation of the plan at this shard count and the next two,
 * with the per-shard overhead outside Playwright measured from the jobs API when it is readable.
 *
 * The simulation follows the `simulate` command of playwright-shard-balancer (Copyright (c) 2026
 * Gary Parker, MIT License): the elapsed time is the slowest shard plus one overhead, the machine
 * time every shard plus one overhead each.
 */

const { applyRun, emptyHistory, runSamples } = require('./history');
const { balance } = require('./plan/balance');
const { createEstimator, median } = require('./plan/estimate');
const { buildUnits, setupCosts, unitId } = require('./plan/units');
const { formatMs, short } = require('./util');

/** The units, setup costs and phases of a run, priced from the run's own samples. */
function runModel(records, key = 'simulation') {
  const { history } = applyRun(emptyHistory(key), {
    id: 1,
    attempt: 1,
    commit: '',
    fingerprint: '',
    date: '2000-01-01',
    samples: runSamples(records),
  });
  const estimator = createEstimator(history.tests);
  const seen = new Set();
  const tests = [];
  const setupTests = [];
  const deps = new Map();
  const phases = new Map();
  for (const record of records) {
    for (const [project, list] of Object.entries(record.projects || {})) deps.set(project, list);
    for (const [project, phase] of Object.entries(record.phases || {})) phases.set(project, phase);
    for (const test of record.tests) {
      const [project, file] = JSON.parse(test.key);
      const entry = { key: test.key, project, file, repeat: test.repeat, staticSkip: false };
      if (test.setup) {
        if (!seen.has(`setup\0${test.key}`)) setupTests.push(entry);
        seen.add(`setup\0${test.key}`);
      } else if (!seen.has(test.id)) {
        seen.add(test.id);
        tests.push(entry);
      }
    }
  }
  tests.sort((a, b) => {
    const ua = unitId(a.project, a.file, a.repeat);
    const ub = unitId(b.project, b.file, b.repeat);
    return ua < ub ? -1 : ua > ub ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const { units } = buildUnits(tests, estimator, (project) => deps.get(project) || []);
  return { units, setup: setupCosts(setupTests, estimator), phases };
}

/** Rows `{ shards, balancedMs, elapsedMs, machineMs }` for each shard count. */
function simulate(records, { counts, workers = 1, overheadMs = null }) {
  const model = runModel(records);
  return counts.map((n) => {
    const plan = balance(model.units, n, workers, model.setup, model.phases);
    const overhead = overheadMs || 0;
    return {
      shards: n,
      balancedMs: plan.makespanMs,
      elapsedMs: overheadMs === null ? null : plan.makespanMs + overhead,
      machineMs:
        overheadMs === null ? null : plan.shards.reduce((acc, s) => acc + s.wallMs + overhead, 0),
    };
  });
}

/**
 * The per-shard overhead: each shard job's duration minus its Playwright run, matched by runner
 * name, attempt and a job window that contains the run, median over the shards. `jobs` come from
 * the jobs API. Null when no shard matches.
 */
function overheadFrom(records, jobs) {
  const values = [];
  for (const record of records) {
    // A persistent self-hosted runner keeps its name across jobs, so the job must also contain
    // the Playwright run in time.
    const start = Date.parse(record.startedAt);
    const job = jobs.find(
      (j) =>
        record.runner &&
        j.runner_name === record.runner &&
        (j.run_attempt === undefined || j.run_attempt === record.run.attempt) &&
        j.started_at &&
        j.completed_at &&
        Number.isFinite(start) &&
        Date.parse(j.started_at) <= start &&
        start + record.wallMs <= Date.parse(j.completed_at)
    );
    if (!job) continue;
    const jobMs = Date.parse(job.completed_at) - Date.parse(job.started_at);
    if (Number.isFinite(jobMs) && jobMs >= record.wallMs) values.push(jobMs - record.wallMs);
  }
  return values.length ? median(values) : null;
}

/** Reads the jobs of a run through the REST API. Returns `{ jobs }` or `{ error }`. */
async function fetchJobs(env = process.env, fetchImpl = globalThis.fetch, token = '') {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  if (!token || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID || typeof fetchImpl !== 'function') {
    return { error: 'no token or run to read the jobs API with' };
  }
  const jobs = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const url = `${api}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/jobs?filter=all&per_page=100&page=${page}`;
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      if (response.status === 403) {
        return {
          error: 'the jobs API answered 403: give the finish job `permissions: actions: read`',
        };
      }
      if (response.status === 404) {
        return {
          error:
            `the jobs API answered 404 for run ${env.GITHUB_RUN_ID} at ${api}: check the run and ` +
            'the API URL, and that the finish job has `permissions: actions: read`',
        };
      }
      if (!response.ok) return { error: `the jobs API answered ${response.status}` };
      const body = await response.json();
      jobs.push(...(body.jobs || []));
      if (!body.jobs || body.jobs.length < 100) break;
    }
  } catch (error) {
    return { error: `the jobs API failed: ${error.message}` };
  }
  return { jobs };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

/** The meaning of each state of the exactly-once check, for the summary line. */
const EXACTLY_ONCE = {
  ok: 'every test ran exactly once',
  failed: 'see the problems below',
  'not checked': 'balancing is disabled, so no reporter recorded the tests',
};

/** The markdown of one suite in the finish summary, under the heading `title`. */
function markdown({
  title,
  plan,
  check,
  exactlyOnce = null,
  simulation = null,
  overheadNote = null,
}) {
  const lines = [
    `### ${title}: ${check.ok ? 'ok' : 'failed'}`,
    '',
    `Mode **${plan.mode}** for ${plan.total} shards${plan.reason ? ` (${plan.reason})` : ''}` +
      (plan.sha ? `, snapshot \`${short(plan.sha)}\`` : '') +
      '.',
    '',
    ...(exactlyOnce
      ? [`Exactly-once check **${exactlyOnce}**: ${EXACTLY_ONCE[exactlyOnce]}.`, '']
      : []),
  ];
  const records = check.records;
  if (records.length) {
    lines.push(
      '| Shard | Attempt | Tests | Predicted | Measured | Test time | Status |',
      '| --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const r of records) {
      const predicted = r.predictedMs ? r.predictedMs[r.shard.current - 1] : null;
      lines.push(
        `| ${r.shard.current} | ${r.run.attempt} | ${r.tests.filter((t) => !t.setup).length} | ` +
          `${formatMs(predicted)} | ${formatMs(r.wallMs)} | ${formatMs(r.testsMs)} | ${r.status} |`
      );
    }
    const walls = records.map((r) => r.wallMs);
    const slowest = records.reduce((a, b) => (b.wallMs > a.wallMs ? b : a));
    const mean = walls.reduce((a, b) => a + b, 0) / walls.length;
    lines.push(
      '',
      `Slowest shard ${slowest.shard.current} at ${formatMs(slowest.wallMs)}, spread ` +
        `${formatMs(Math.max(...walls) - Math.min(...walls))}, imbalance ` +
        `${pct(mean ? (Math.max(...walls) - mean) / mean : 0)} (slowest over the mean).`
    );
    const plans = [...new Set(records.map((r) => r.planSha).filter(Boolean))];
    if (plans.length) lines.push(`Plan \`${plans.map(short).join('`, `')}\`.`);
  }
  if (check.problems.length) lines.push('', ...check.problems.map((p) => `- ${p}`));
  if (simulation) {
    lines.push(
      '',
      '| Shards | Balanced slowest shard | Elapsed with overhead | Machine time with overhead |',
      '| --- | --- | --- | --- |',
      ...simulation.map(
        (row) =>
          `| ${row.shards} | ${formatMs(row.balancedMs)} | ${formatMs(row.elapsedMs)} | ${formatMs(row.machineMs)} |`
      )
    );
    if (overheadNote) lines.push('', overheadNote);
  }
  return `${lines.join('\n')}\n\n`;
}

module.exports = { fetchJobs, markdown, overheadFrom, runModel, simulate };
