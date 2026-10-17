'use strict';

/**
 * The optional finish action, in the user's own job after the shards. It downloads the run
 * records every shard's post step uploaded and the start markers every shard's main step
 * uploaded, groups the records into suites (one shard job, history key, corpus and shard count
 * each), proves exactly-once coverage of each suite (lib/check.js), where a shard job that started
 * and left no record keeps an earlier attempt's record of its shard from standing, and
 * writes the job summary: shard times, the plan, and a simulation at this shard count and the next
 * two with the per-shard overhead measured from the jobs API. It fails when a suite fails its
 * check. It merges no reports and writes no history; the shards publish their own samples.
 *
 * `history-key` narrows the check to the shards that ran with that history key, for a workflow
 * with several sharded jobs and a finish for each.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  START_SCHEMA,
  STATUS_SCHEMA,
  checkRun,
  unanswered,
  validateRecord,
  validateStart,
  validateStatus,
} = require('./check');
const { FINISH_INPUTS, readInputs } = require('./inputs');
const { fetchJobs, markdown, overheadFrom, simulate } = require('./summary');
const { formatMs, readJsonFile } = require('./util');

const PREFIXES = ['psp-record-', 'psp-start-'];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Downloads every record and start marker artifact of the run: `{ records, statuses, starts,
 * malformed }`.
 */
async function downloadRecords(artifacts, dir) {
  const records = [];
  const statuses = [];
  const starts = [];
  const malformed = [];
  const listed = (await artifacts.list()).filter((a) =>
    PREFIXES.some((prefix) => a.name.startsWith(prefix))
  );
  for (const artifact of listed.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(dir, artifact.name);
    await artifacts.download(artifact.id, target);
    for (const file of walk(target).filter((f) => f.endsWith('.json'))) {
      const name = `${artifact.name}/${path.relative(target, file)}`;
      try {
        const data = readJsonFile(file);
        if (data && data.schema === STATUS_SCHEMA) statuses.push(validateStatus(data, name));
        else if (data && data.schema === START_SCHEMA) starts.push(validateStart(data, name));
        else records.push(validateRecord(data, name));
      } catch (error) {
        malformed.push(`${name}: ${error.message}`);
      }
    }
  }
  return { records, statuses, starts, malformed };
}

const suiteOf = (r) => `${r.job}|${r.key}|${r.corpusSha || 'none'}|${r.shard.total}`;

/** The suites of the records, in a stable order: `[{ job, key, total, historyKey, records }]`. */
function suites(records) {
  const by = new Map();
  for (const r of records) {
    const id = suiteOf(r);
    if (!by.has(id)) {
      by.set(id, {
        job: r.job,
        key: r.key,
        total: r.shard.total,
        historyKey: r.historyKey || '',
        records: [],
      });
    }
    by.get(id).records.push(r);
  }
  return [...by.keys()].sort().map((id) => by.get(id));
}

const titleOf = (suite) =>
  `Playwright Smart Parallelization, job \`${suite.job}\`` +
  (suite.historyKey ? `, history key \`${suite.historyKey}\`` : '');

async function finish({ env = process.env, io, artifacts, fetchImpl = globalThis.fetch }) {
  const inputs = readInputs(FINISH_INPUTS, env);
  const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'psp-finish-'));
  const downloaded = await downloadRecords(artifacts, dir);
  const only = inputs['history-key'];
  const mine = (r) => !only || (r.historyKey || '') === only;
  const records = downloaded.records.filter(mine);
  const statuses = downloaded.statuses.filter(mine);
  const runId = Number(env.GITHUB_RUN_ID || 0);
  const jobOf = (r) => `${r.job}|${r.key}`;
  const unrecorded = unanswered(
    downloaded.starts.filter((s) => mine(s) && s.run.id === runId),
    downloaded.records
  );

  const groups = suites(records).map((suite) => ({
    suite,
    check: checkRun(
      {
        total: suite.total,
        runId,
        unrecorded: unrecorded.filter((s) => jobOf(s) === jobOf(suite)),
      },
      suite.records
    ),
  }));
  const problems = downloaded.malformed.map((m) => `malformed record ${m}`);
  const checkedJobs = new Set(groups.map((g) => jobOf(g.suite)));
  const unchecked = unrecorded.filter((s) => !checkedJobs.has(jobOf(s)));
  for (const start of unchecked) {
    problems.push(
      `a shard job of job ${start.job} started in attempt ${start.run.attempt} and no shard of ` +
        'its job left a record: Playwright stopped before it loaded the reporter, the job was ' +
        'cancelled, $PSP_ARGS is missing from its command, or the upload failed'
    );
  }
  if (!records.length && !statuses.length && !unrecorded.length) {
    problems.push(
      `no run records${only ? ` with history key ${only}` : ''}: no shard ran the Action with $PSP_ARGS in its Playwright command`
    );
  }

  const checked = groups.flatMap((g) => g.check.records);
  let jobs = null;
  if (checked.length) jobs = await fetchJobs(env, fetchImpl, inputs['github-token']);
  const overheads = [];
  const sections = [];
  for (const { suite, check } of groups) {
    const first = check.records[0] || suite.records[0];
    const plan = {
      mode: first.mode,
      total: suite.total,
      reason: first.mode === 'native' ? first.reason : null,
      sha: first.snapshotSha,
    };
    let simulation = null;
    let overheadNote = null;
    if (check.records.length && check.coverageOk) {
      const overheadMs = jobs && jobs.jobs ? overheadFrom(check.records, jobs.jobs) : null;
      if (overheadMs !== null) overheads.push(overheadMs);
      overheadNote =
        overheadMs === null
          ? `Per-shard overhead not measured (${(jobs && jobs.error) || 'no shard job matched its record'}), so only the balanced slowest shard is shown.`
          : `Per-shard overhead outside Playwright: ${formatMs(overheadMs)} (median over the shard jobs).`;
      simulation = simulate(check.records, {
        counts: [suite.total, suite.total + 1, suite.total + 2],
        workers: first.workers || 1,
        overheadMs,
      });
    }
    sections.push(
      markdown({
        title: titleOf(suite),
        plan,
        check,
        coverage: check.coverageOk ? 'ok' : 'failed',
        simulation,
        overheadNote,
      })
    );
    for (const problem of check.problems) io.info(`job ${suite.job}: ${problem}`);
  }
  const disabledJobs = [...new Set(statuses.map((s) => s.job))].sort();
  if (disabledJobs.length) {
    sections.push(
      `### Playwright Smart Parallelization, job${disabledJobs.length > 1 ? 's' : ''} ` +
        `${disabledJobs.map((j) => `\`${j}\``).join(', ')}: disabled\n\n` +
        'Balancing is off (`enabled: false`), so no reporter recorded the tests and coverage is not checked.\n\n'
    );
  }
  if (problems.length) sections.push(`${problems.map((p) => `- ${p}`).join('\n')}\n\n`);
  io.summary(sections.join(''));

  const ok = problems.length === 0 && groups.every((g) => g.check.ok);
  const modes = [
    ...new Set([
      ...groups.map((g) => g.check.records[0]?.mode || g.suite.records[0].mode),
      ...statuses.map(() => 'disabled'),
    ]),
  ];
  const coverage = groups.length
    ? groups.every((g) => g.check.coverageOk) && !downloaded.malformed.length && !unchecked.length
      ? 'ok'
      : 'failed'
    : statuses.length
      ? 'not checked'
      : 'failed';
  io.setOutput('mode', modes.length === 1 ? modes[0] : modes.length ? 'mixed' : '');
  io.setOutput('coverage', coverage);
  io.setOutput('overhead-ms', overheads.length ? String(Math.round(Math.max(...overheads))) : '');
  for (const problem of problems) io.info(problem);
  if (!ok) io.setFailed('the run failed its check; see the job summary');
  return { ok, coverage, groups, statuses };
}

module.exports = { downloadRecords, finish, suites };
