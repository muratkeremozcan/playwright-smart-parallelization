'use strict';

/**
 * The finish phase, once after the shards. `setup` names the artifacts to download. `check` keeps
 * the latest attempt of each shard's record, proves exactly-once coverage (lib/check.js), writes
 * the job summary and decides whether this run publishes: only a complete run whose every shard
 * passed and whose check passed, in balanced or native mode, from a trusted writer, with
 * `publish-history` allowing it (see `trust`). `report` merges the shards' blob reports
 * (`mergeCommand`). `conclude` outputs the mode, coverage and history, and fails the job when the
 * check failed, a shard failed, or the history could not be published.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { artifactNames, cachePrefix } = require('./identity');
const {
  RECORD_SCHEMA,
  STATUS_SCHEMA,
  checkRun,
  checkStatuses,
  validateRecord,
  validateStatus,
} = require('./check');
const { runSamples } = require('./history');
const { parsePlan, publishInput } = require('./inputs');
const { newState, loadState, saveState } = require('./store');
const { fetchJobs, markdown, overheadFrom, simulate } = require('./summary');
const { formatMs, readJsonFile, writeAtomic } = require('./util');

function dirs(plan, env) {
  const base = path.join(env.RUNNER_TEMP || os.tmpdir(), `psp-finish-${plan.key.slice(0, 12)}`);
  return {
    base,
    records: path.join(base, 'records'),
    blobs: path.join(base, 'blobs'),
    merged: path.join(base, 'blob-merged'),
    report: path.join(base, 'report'),
    state: path.join(base, 'state'),
  };
}

function setup({ inputs, env = process.env }) {
  const plan = parsePlan(inputs.plan, env);
  publishInput(inputs['publish-history']);
  const names = artifactNames(plan);
  const where = dirs(plan, env);
  fs.rmSync(where.base, { recursive: true, force: true });
  for (const dir of [where.records, where.blobs, where.state])
    fs.mkdirSync(dir, { recursive: true });
  return {
    outputs: {
      mode: plan.mode,
      records: 'true',
      'records-pattern': `${names.recordPrefix}*`,
      'records-dir': where.records,
      'blob-pattern': `${names.blobPrefix}*`,
      'blob-dir': where.blobs,
      'state-dir': where.state,
      'report-dir': where.report,
      'report-name': `playwright-report-${plan.key.slice(0, 12)}-${plan.runId}`,
    },
  };
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Every record file under `dir`: `{ records, statuses, malformed }`. A status record is what a
 * disabled shard writes in place of a run record.
 */
function readRecords(dir) {
  const records = [];
  const statuses = [];
  const malformed = [];
  for (const file of walk(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const name = path.relative(dir, file);
    try {
      const data = readJsonFile(file);
      if (data && data.schema === STATUS_SCHEMA) statuses.push(validateStatus(data, name));
      else records.push(validateRecord(data, name));
    } catch (error) {
      malformed.push(`${name}: ${error.message}`);
    }
  }
  return { records, statuses, malformed };
}

/**
 * Whether this run may publish, under `publish-history` (`mode`). A pull request from a fork and
 * any `pull_request_target` run never publish: they read the base history like any run. `auto`
 * publishes from the repository's default branch only, because a cache entry saved on another ref
 * is visible to that ref alone and would leave it reading its own stale entries. `true` also
 * publishes from same-repository branches and pull requests, into their own cache scope.
 */
function trust(env = process.env, mode = 'auto') {
  if (mode === 'false') return { trusted: false, reason: 'publish-history is false' };
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    return { trusted: false, reason: 'a pull_request_target run never publishes history' };
  }
  let event = null;
  try {
    if (env.GITHUB_EVENT_PATH) event = readJsonFile(env.GITHUB_EVENT_PATH);
  } catch {
    return { trusted: false, reason: 'the event payload is unreadable' };
  }
  const pr = event && event.pull_request;
  if (pr) {
    const head = pr.head && pr.head.repo && pr.head.repo.full_name;
    if (!head || head !== env.GITHUB_REPOSITORY) {
      return {
        trusted: false,
        reason: `pull request from ${head || 'a deleted fork'}, which does not publish history`,
      };
    }
    if (mode === 'auto') {
      return {
        trusted: false,
        reason:
          'publish-history auto publishes from the default branch only, and this run is a pull request',
      };
    }
    return { trusted: true, reason: null };
  }
  if (mode === 'true') return { trusted: true, reason: null };
  // GitHub runs scheduled workflows on the default branch only, and their payload may carry no
  // repository object to name it.
  if (env.GITHUB_EVENT_NAME === 'schedule' && (env.GITHUB_REF || '').startsWith('refs/heads/')) {
    return { trusted: true, reason: null };
  }
  const branch = event && event.repository && event.repository.default_branch;
  if (!branch) {
    return { trusted: false, reason: 'the default branch is unknown from the event payload' };
  }
  if (env.GITHUB_REF !== `refs/heads/${branch}`) {
    return {
      trusted: false,
      reason: `publish-history auto publishes from ${branch} only; this run is on ${env.GITHUB_REF || 'no ref'}`,
    };
  }
  return { trusted: true, reason: null };
}

async function check({ inputs, env = process.env, fetchImpl = globalThis.fetch }) {
  const plan = parsePlan(inputs.plan, env);
  const where = dirs(plan, env);
  const mode = publishInput(inputs['publish-history']);
  const { records, statuses, malformed } = readRecords(where.records);
  const result = plan.mode === 'disabled' ? checkStatuses(plan, statuses) : checkRun(plan, records);
  if (malformed.length) {
    result.problems.unshift(...malformed.map((m) => `malformed record ${m}`));
    result.ok = false;
    result.coverageOk = false;
  }
  // Without the reporter, a disabled run proves nothing about coverage: it checks the shards only.
  const coverage = plan.mode === 'disabled' ? 'not checked' : result.coverageOk ? 'ok' : 'failed';
  const trusted = trust(env, mode);
  let publish = false;
  let why;
  if (plan.mode === 'disabled') why = 'balancing is disabled for this run, so nothing is published';
  else if (!result.ok) why = 'the run did not pass its check, so the history stays as it was';
  else if (!trusted.trusted) why = `${trusted.reason}`;
  else {
    publish = true;
    why = 'publishing this run to the history';
  }

  let simulation = null;
  let overheadNote = null;
  let overheadMs = null;
  if (result.records.length && result.coverageOk) {
    const jobs = await fetchJobs(env, fetchImpl);
    overheadMs = jobs.jobs ? overheadFrom(result.records, jobs.jobs) : null;
    overheadNote =
      overheadMs === null
        ? `Per-shard overhead not measured (${jobs.error || 'no shard job matched its record'}), so only the balanced slowest shard is shown.`
        : `Per-shard overhead outside Playwright: ${formatMs(overheadMs)} (median over the shard jobs).`;
    simulation = simulate(result.records, {
      counts: [plan.total, plan.total + 1, plan.total + 2],
      workers: plan.workers || 1,
      overheadMs,
    });
  }

  const state = newState({
    key: plan.key,
    pinned: plan.seq === null ? null : { epoch: plan.epoch, seq: plan.seq },
    run: {
      id: plan.runId,
      attempt: Math.max(1, ...result.records.map((r) => r.run.attempt)),
      commit: plan.commit,
      fingerprint: plan.fingerprint || '',
      date: (env.PSP_TODAY || new Date().toISOString()).slice(0, 10),
      samples: [...runSamples(result.records)],
    },
  });
  saveState(where.state, state);
  writeAtomic(
    path.join(where.state, 'finish.json'),
    `${JSON.stringify({ ok: result.ok, coverage, publish, why, problems: result.problems })}\n`
  );
  return {
    outputs: {
      publish: publish ? 'true' : 'false',
      prefix: cachePrefix(plan.key),
      'overhead-ms': overheadMs === null ? '' : String(overheadMs),
    },
    summary: markdown({
      plan,
      check: result,
      coverage,
      simulation,
      overheadNote,
      publish: `History: ${why}.`,
    }),
    log: [...result.problems, why],
    ok: result.ok,
  };
}

/** Copies the blob reports of the latest attempt of every shard into one folder. */
function collectBlobs(blobDir, mergedDir, plan) {
  const prefix = artifactNames(plan).blobPrefix;
  const latest = new Map();
  if (fs.existsSync(blobDir)) {
    for (const name of fs.readdirSync(blobDir)) {
      if (!fs.statSync(path.join(blobDir, name)).isDirectory()) continue;
      const match = /^(\d+)-attempt-(\d+)$/.exec(
        name.startsWith(prefix) ? name.slice(prefix.length) : ''
      );
      if (!match) continue;
      const [shard, attempt] = [Number(match[1]), Number(match[2])];
      if (!latest.has(shard) || latest.get(shard).attempt < attempt)
        latest.set(shard, { attempt, name });
    }
  }
  fs.rmSync(mergedDir, { recursive: true, force: true });
  // download-artifact@v8 (src/download-artifact.ts at v8.0.2) puts a single pattern match straight
  // into the folder and several into folders of their names, so both layouts are read.
  const sources = latest.size
    ? [...latest.values()].map(({ name }) => ({ name, dir: path.join(blobDir, name) }))
    : [{ name: 'shard', dir: blobDir }];
  let files = 0;
  for (const { name, dir } of sources) {
    for (const file of walk(dir)) {
      fs.mkdirSync(mergedDir, { recursive: true });
      fs.copyFileSync(file, path.join(mergedDir, `${name}-${path.basename(file)}`));
      files++;
    }
  }
  return files;
}

/**
 * The merge-reports command: the Playwright installed in the working directory when there is one,
 * else `npx playwright@<plan version>` from npm. `merge-config` (relative to the working
 * directory) becomes `--config`; without it the merge writes the HTML report. Under
 * `pull_request_target` the checkout may be the pull request's and the token can write, so the
 * merge runs `npx playwright@<plan version>` alone and `merge-config` is ignored: no code from the
 * checkout runs. Returns `{ command, args, source, warning }`, or null when nothing can merge.
 */
function mergeCommand(plan, inputs, env) {
  const cwd = path.join(env.GITHUB_WORKSPACE || process.cwd(), plan.workingDirectory);
  const untrusted = env.GITHUB_EVENT_NAME === 'pull_request_target';
  const warning =
    untrusted && inputs['merge-config']
      ? 'merge-config is ignored under pull_request_target, which runs no code from the checkout'
      : null;
  const options =
    inputs['merge-config'] && !untrusted
      ? ['merge-reports', `--config=${path.resolve(cwd, inputs['merge-config'])}`]
      : ['merge-reports', '--reporter=html'];
  for (const cli of untrusted ? [] : ['@playwright/test/cli', 'playwright/cli']) {
    try {
      const file = require.resolve(cli, { paths: [cwd] });
      return {
        command: process.execPath,
        args: [file, ...options],
        source: `the Playwright in ${plan.workingDirectory}`,
        warning,
      };
    } catch {
      // Not installed under this name.
    }
  }
  if (!plan.playwright) return null;
  return {
    command: 'npx',
    args: ['--yes', `playwright@${plan.playwright}`, ...options],
    source: `playwright@${plan.playwright} from npm`,
    warning,
  };
}

/**
 * Merges the blob reports of the latest attempts into the report folder (see `mergeCommand`).
 * `merged` is true only when the folder then holds files, which is what the upload step needs.
 * Returns `{ outputs, log, annotations }`; a failed merge is a warning, since the check already
 * decided.
 */
function report({ inputs, env = process.env, spawn = spawnSync }) {
  const plan = parsePlan(inputs.plan, env);
  const where = dirs(plan, env);
  const files = collectBlobs(where.blobs, where.merged, plan);
  if (files === 0)
    return { outputs: { merged: 'false' }, log: ['no blob reports to merge'], annotations: [] };
  const merge = mergeCommand(plan, inputs, env);
  if (!merge) {
    return {
      outputs: { merged: 'false' },
      log: [],
      annotations: [
        'blob reports were uploaded, but no Playwright is installed or known to merge them',
      ],
    };
  }
  fs.rmSync(where.report, { recursive: true, force: true });
  fs.mkdirSync(where.report, { recursive: true });
  const { command, args, source, warning } = merge;
  const notes = warning ? [warning] : [];
  const result = spawn(command, [...args, where.merged], {
    cwd: where.state,
    env: { ...env, PLAYWRIGHT_HTML_OUTPUT_DIR: where.report, PLAYWRIGHT_HTML_OPEN: 'never' },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    return {
      outputs: { merged: 'false' },
      log: [],
      annotations: [
        ...notes,
        `merging ${files} blob report file(s) failed with exit ${result.status}`,
      ],
    };
  }
  if (walk(where.report).length === 0) {
    return {
      outputs: { merged: 'false' },
      log: [],
      annotations: [
        ...notes,
        `merging ${files} blob report file(s) wrote nothing to upload; the merge config needs a reporter that writes the HTML report`,
      ],
    };
  }
  return {
    outputs: { merged: 'true' },
    log: [`merged ${files} blob report file(s) with ${source}`],
    annotations: notes,
  };
}

/** The exit code of the finish phase and the line that explains it. */
function conclude({ inputs, env = process.env }) {
  const plan = parsePlan(inputs.plan, env);
  const where = dirs(plan, env);
  const finish = readJsonFile(path.join(where.state, 'finish.json'));
  const store = loadState(where.state);
  const lines = [...store.log];
  let code = finish.ok ? 0 : 1;
  if (store.status === 'unavailable') {
    // The cache returned nothing although prepare read an entry: nothing is published, and a
    // passing run stays green.
  } else if (finish.publish && store.status !== 'published' && store.status !== 'already') {
    lines.push(`the history could not be published (${store.status}); it is unchanged`);
    code = 1;
  }
  for (const error of store.errors || []) {
    lines.push(error);
    code = 1;
  }
  if (!finish.ok) lines.push('the run failed its check; see the job summary');
  const summary = lines.length ? `${lines.map((l) => `- ${l}`).join('\n')}\n\n` : '';
  // published: this run wrote a new entry; unchanged: nothing was written; failed: a write was
  // due and did not happen.
  let history = 'unchanged';
  if (store.status === 'published') history = 'published';
  else if (finish.publish && store.status !== 'already' && store.status !== 'unavailable') {
    history = 'failed';
  }
  return {
    code,
    log: lines,
    summary,
    outputs: { mode: plan.mode, coverage: finish.coverage, history },
  };
}

module.exports = {
  RECORD_SCHEMA,
  check,
  collectBlobs,
  conclude,
  mergeCommand,
  readRecords,
  report,
  setup,
  trust,
};
