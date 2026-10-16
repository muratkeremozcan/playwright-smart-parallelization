'use strict';

/**
 * Starts runs of the arms a config describes, one at a time, and collects each into a raw record.
 * Usage:
 *
 *   node measurements/dispatch.js --config measurements/couture-cast-s6.json \
 *     --out docs/measurements/raw/candidates --label flakiness-warmup --pair 1
 *   node measurements/dispatch.js --config measurements/couture-cast-s6.json \
 *     --out docs/measurements/raw/candidates --campaign
 *
 * Right before every dispatch it waits until no workflow run of the repository is queued or in
 * progress, because concurrent runs share one image registry limit, then reads the branch head and
 * proves it descends from the base and from the minimum commit. It never re-runs a run. A run that
 * cannot be collected is still written, as a stub with its reason. After each run it records the
 * other runs of the repository that overlapped it.
 *
 * The campaign pairs every measured arm with the control until each has `pairs` matched pairs (see
 * pairs.js). Pair k of the arm at position i runs the control first when k + i is odd. A half that
 * stopped before its test step is run again; a half that stopped inside it breaks the pair, which
 * stays on disk, and the arm takes its next pair number.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { analyzeRun } = require('./analyze');
const { collectRun, ghApi, ghDownload, ghRaw, lineage, readReportText } = require('./collect');
const { pairStates } = require('./pairs');

const POLL_MS = 60_000;
const FIND_POLL_MS = 10_000;
const FIND_LIMIT_MS = 5 * 60_000;
/** A run listed this long before the dispatch call is never taken for the dispatched one. */
const CLOCK_SKEW_MS = 5_000;
/** Runs one half of a pair may take before the campaign stops and asks why. */
const MAX_TRIES = 3;
/** Pair numbers an arm may use beyond `pairs` for broken and stale pairs before the campaign stops. */
const EXTRA_PAIRS = 3;
/** How far back the overlap check looks for runs that were still going when this one started. */
const OVERLAP_LOOKBACK_MS = 3 * 60 * 60_000;
const ACTIVE = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const iso = (value) => new Date(value).toISOString();

function ghDispatch(repo, workflow, branch) {
  execFileSync(
    'gh',
    ['workflow', 'run', path.basename(workflow), '--repo', repo, '--ref', branch],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
    }
  );
}

/** Runs of the repository that are queued or in progress, of any workflow. */
function activeRuns(api, repo) {
  return ACTIVE.flatMap(
    (status) => api(`repos/${repo}/actions/runs?status=${status}&per_page=100`).workflow_runs
  );
}

/** Other runs of the repository whose lifetime overlaps `run` (created to last update). */
function overlappingRuns(api, repo, run) {
  const start = Date.parse(run.created_at);
  const end = Date.parse(run.updated_at);
  const since = iso(start - OVERLAP_LOOKBACK_MS).slice(0, 19);
  const listed = [];
  for (let page = 1; ; page += 1) {
    const body = api(`repos/${repo}/actions/runs?created=>=${since}Z&per_page=100&page=${page}`);
    listed.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) break;
  }
  return listed
    .filter(
      (other) =>
        other.id !== run.id &&
        Date.parse(other.created_at) < end &&
        Date.parse(other.updated_at) > start
    )
    .map((other) => ({
      id: other.id,
      workflow: other.path || other.name,
      createdAt: other.created_at,
    }));
}

function readRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

/** Analyzed runs with the label they are paired for, as pairs.js reads them. */
const analyzed = (records) =>
  records.map((record) => ({ ...analyzeRun(record), comparison: record.comparison || null }));

/** True when `records` already hold a run with timings for this label, pair and comparison. */
function slotDone(records, step) {
  return analyzed(records).some(
    (run) =>
      run.label === step.label &&
      run.pair === step.pair &&
      run.comparison === (step.comparison || null) &&
      !run.excluded
  );
}

/** The record of a run the collector could not turn into a full record. */
function stubRecord(config, step, arm, run, base, error) {
  return {
    schema: 2,
    label: step.label,
    pair: step.pair,
    labelNote: arm.note,
    repo: config.repo,
    workflow: config.workflow,
    testStep: config.testStep,
    facts: config.facts,
    serialSuites: config.serialSuites,
    collectError: error.message.split('\n')[0].slice(0, 300),
    run: {
      id: run.id,
      attempt: run.run_attempt,
      event: run.event,
      branch: run.head_branch,
      sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url,
    },
    comparison: step.comparison || null,
    arm: {
      branch: arm.branch,
      shards: arm.shards,
      workers: arm.workers,
      engine: arm.engine,
      phase: arm.phase,
      command: arm.command,
      stressOf: arm.stressOf || null,
    },
    base,
  };
}

/** Dispatches one run of `step.label`, waits for it and writes its record into `out`. */
function measure(io, config, step, out) {
  const { api, dispatch, sleep, now, log } = io;
  const repo = `${config.repo.owner}/${config.repo.name}`;
  const arm = config.labels[step.label];
  if (!arm || typeof arm !== 'object') throw new Error(`label ${step.label} is not an arm`);
  if (arm.phase === 'measured' && !step.comparison) {
    throw new Error(`${step.label} is measured, so it needs the label it is paired for`);
  }
  let sha;
  let base;
  for (;;) {
    const active = activeRuns(api, repo);
    if (active.length > 0) {
      log(`waiting for ${active.length} active run(s): ${active.map((r) => r.id).join(', ')}`);
      sleep(POLL_MS);
      continue;
    }
    // read the head after the wait, so the commit proven is the commit dispatched
    sha = api(`repos/${repo}/branches/${encodeURIComponent(arm.branch)}`).commit.sha;
    base = lineage(api, repo, config, sha);
    if (activeRuns(api, repo).length === 0) break;
  }
  const dispatchedAt = now();
  dispatch(repo, config.workflow, arm.branch);
  const workflowFile = path.basename(config.workflow);
  let run;
  for (let waited = 0; !run; waited += FIND_POLL_MS) {
    if (waited > FIND_LIMIT_MS) throw new Error(`no run of ${arm.branch} appeared after dispatch`);
    sleep(FIND_POLL_MS);
    const listed = api(
      `repos/${repo}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&branch=${encodeURIComponent(arm.branch)}&per_page=10`
    ).workflow_runs.filter(
      (r) => Date.parse(r.created_at) >= dispatchedAt - CLOCK_SKEW_MS && r.head_sha === sha
    );
    if (listed.length > 1) throw new Error(`${listed.length} runs appeared for one dispatch`);
    [run] = listed;
  }
  log(`${step.label} pair ${step.pair}: run ${run.id} ${run.html_url}`);
  let finished = api(`repos/${repo}/actions/runs/${run.id}`);
  while (finished.status !== 'completed') {
    sleep(POLL_MS);
    finished = api(`repos/${repo}/actions/runs/${run.id}`);
  }
  let record;
  try {
    record = io.collect({
      config,
      label: step.label,
      pair: step.pair,
      runId: String(run.id),
      comparison: step.comparison || null,
    });
    analyzeRun(record);
  } catch (error) {
    record = stubRecord(config, step, arm, finished, base, error);
  }
  record.dispatch = {
    headSha: sha,
    activeAtDispatch: 0,
    dispatchedAt: iso(dispatchedAt),
    overlapping: overlappingRuns(api, repo, finished),
  };
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${step.label}-${record.run.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const result = analyzeRun(record);
  log(
    `${file}: ${record.run.conclusion}${result.excluded ? `, no timings: ${result.excluded}` : ''}`
  );
  return record;
}

/** Measured arms other than the control, in config order. */
function armsOf(config) {
  return Object.entries(config.labels)
    .filter(([label, arm]) => label !== config.control && arm.phase === 'measured')
    .map(([label]) => label);
}

/**
 * Throws unless every measured label's branch has a warm-up run with timings on the commit its
 * branch head is at now: the arm works, its caches are filled, and an engine has its timings.
 */
function requireWarm(io, config, records) {
  const repo = `${config.repo.owner}/${config.repo.name}`;
  const runs = analyzed(records);
  const byId = new Map(records.map((r) => [r.run.id, r]));
  for (const label of [config.control, ...armsOf(config)]) {
    const branch = config.labels[label].branch;
    const head = io.api(`repos/${repo}/branches/${encodeURIComponent(branch)}`).commit.sha;
    const warm = runs.some((run) => {
      const record = byId.get(run.id);
      return (
        !run.excluded &&
        record.arm.phase === 'warm-up' &&
        record.arm.branch === branch &&
        record.run.sha === head
      );
    });
    if (!warm) throw new Error(`${branch} has no warm-up run with timings at ${head.slice(0, 12)}`);
  }
}

/** Runs one pair half by half in its order; stops early when a half breaks the pair. */
function runPair(io, config, out, arm, pair, position) {
  const halves = [
    { label: config.control, pair, comparison: arm },
    { label: arm, pair, comparison: arm },
  ];
  if ((pair + position) % 2 === 0) halves.reverse();
  for (const half of halves) {
    for (let tries = 0; ; tries += 1) {
      const state = pairStates(analyzed(readRecords(out)), config.control, arm).find(
        (s) => s.pair === pair
      );
      if (state && state.status === 'broken') return;
      if (slotDone(readRecords(out), half)) break;
      if (tries === MAX_TRIES) {
        throw new Error(`${half.label} pair ${pair} has no timings after ${MAX_TRIES} runs`);
      }
      measure(io, config, half, out);
    }
  }
}

/** The pair number an arm works on next: its last pair while that is open, else one more. */
function nextPair(states) {
  if (states.length === 0) return 1;
  const last = states[states.length - 1];
  return last.status === 'open' ? last.pair : last.pair + 1;
}

/** Pairs every measured arm with the control until each has `config.pairs` matched pairs. */
function campaign(io, config, out) {
  requireWarm(io, config, readRecords(out));
  const arms = armsOf(config);
  for (let round = 1; ; round += 1) {
    const offset = (round - 1) % arms.length;
    const rotated = [...arms.slice(offset), ...arms.slice(0, offset)];
    let pending = false;
    for (const arm of rotated) {
      const states = pairStates(analyzed(readRecords(out)), config.control, arm);
      if (states.filter((s) => s.status === 'matched').length >= config.pairs) continue;
      pending = true;
      const pair = nextPair(states);
      if (pair > config.pairs + EXTRA_PAIRS) {
        throw new Error(`${arm} needs pair ${pair} for ${config.pairs} matched pairs`);
      }
      runPair(io, config, out, arm, pair, arms.indexOf(arm));
    }
    if (!pending) return;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`bad argument ${key}`);
    if (key === '--campaign') {
      args.campaign = true;
      continue;
    }
    if (argv[i + 1] === undefined) throw new Error(`bad argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  for (const required of ['config', 'out']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (!args.campaign) {
    if (!args.label || !/^[1-9]\d*$/.test(args.pair || '')) {
      throw new Error('--label and --pair are required without --campaign');
    }
  }
  return args;
}

/** One run outside the campaign: a warm-up or tolerance run, or a measured half by hand. */
function single(io, config, step, out) {
  if (slotDone(readRecords(out), step)) {
    throw new Error(`${step.label} pair ${step.pair} already has a run with timings`);
  }
  return measure(io, config, step, out);
}

function main(argv) {
  const args = parseArgs(argv);
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const io = {
    api: ghApi,
    dispatch: ghDispatch,
    sleep: sleepSync,
    now: Date.now,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    collect: (options) =>
      collectRun({
        api: ghApi,
        download: ghDownload,
        raw: ghRaw,
        readReport: readReportText,
        ...options,
      }),
  };
  if (args.campaign) campaign(io, config, args.out);
  else {
    single(
      io,
      config,
      { label: args.label, pair: Number(args.pair), comparison: args.comparison || null },
      args.out
    );
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  activeRuns,
  campaign,
  measure,
  nextPair,
  overlappingRuns,
  parseArgs,
  requireWarm,
  single,
  slotDone,
};
