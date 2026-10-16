'use strict';

/**
 * Collects one finished GitHub Actions run into a raw JSON record: the run, every job with its
 * steps, the runner image from each job log, and one reduced blob report per shard. The analyzer
 * reads only these records. Usage:
 *
 *   node measurements/collect.js --config measurements/couture-cast.json --label baseline-a \
 *     --pair 1 --run 123456789 --out docs/measurements/raw
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { reduceBlob } = require('./blob');

const SCHEMA = 1;
const PAGE_SIZE = 100;
const MAX_BUFFER = 256 * 1024 * 1024;

function ghApi(endpoint) {
  const out = execFileSync('gh', ['api', endpoint], { maxBuffer: MAX_BUFFER });
  return JSON.parse(out.toString('utf8'));
}

function ghDownload(endpoint) {
  return execFileSync('gh', ['api', endpoint], { maxBuffer: MAX_BUFFER });
}

/** Reads `report.jsonl` out of a blob artifact: a zip that holds one report zip per shard. */
function readReportText(artifactZip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-'));
  try {
    const outer = path.join(dir, 'artifact.zip');
    fs.writeFileSync(outer, artifactZip);
    const members = execFileSync('unzip', ['-Z1', outer], { encoding: 'utf8' })
      .split('\n')
      .filter((name) => /^(?:.*\/)?report[^/]*\.zip$/.test(name));
    if (members.length !== 1) {
      throw new Error(`expected one report zip in the blob artifact, found ${members.length}`);
    }
    const inner = path.join(dir, 'report.zip');
    fs.writeFileSync(
      inner,
      execFileSync('unzip', ['-p', outer, members[0]], { maxBuffer: MAX_BUFFER })
    );
    return execFileSync('unzip', ['-p', inner, 'report.jsonl'], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every item of a paginated list endpoint; the count must match what the API reports. */
function paginate(api, endpoint, key) {
  const items = [];
  let total;
  for (let page = 1; ; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const body = api(`${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`);
    total = body.total_count;
    const batch = body[key];
    if (!Array.isArray(batch) || typeof total !== 'number') {
      throw new Error(`${endpoint} did not return a ${key} list with a total_count`);
    }
    items.push(...batch);
    if (batch.length === 0 || items.length >= total) break;
  }
  if (items.length !== total) {
    throw new Error(`${endpoint} listed ${items.length} ${key} but reports ${total}`);
  }
  return items;
}

/** The runner facts a job log header states; a missing line stays null. */
function parseRunnerLog(text) {
  const group = (name) => {
    const match = new RegExp(`##\\[group\\]${name}\\r?\\n([\\s\\S]*?)##\\[endgroup\\]`).exec(text);
    // a line of a group carries a timestamp, which comes off before the content is read
    return match ? match[1].split('\n').map((line) => line.replace(/^\S+Z /, '').trim()) : [];
  };
  const valueOf = (lines, key) => {
    const line = lines.find((l) => l.startsWith(`${key}: `));
    return line ? line.slice(key.length + 2) : null;
  };
  const runnerVersion = /Current runner version: '([^']+)'/.exec(text);
  const image = group('Runner Image');
  const system = group('Operating System');
  return {
    runnerVersion: runnerVersion ? runnerVersion[1] : null,
    image: valueOf(image, 'Image'),
    imageVersion: valueOf(image, 'Version'),
    os: system[0] || null,
    osVersion: system[1] || null,
    region: valueOf(group('Runner Image Provisioner'), 'Region'),
  };
}

/** The first `Error` line of a job log, without its timestamp: what a failed job says first. */
function failureNote(text) {
  const match = /^\S+Z (.*\bError\b.*)$/m.exec(text);
  return match ? match[1].trim().slice(0, 200) : null;
}

function reduceJob(job, log, note = null) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    labels: job.labels,
    runnerGroup: job.runner_group_name,
    runner: log,
    failureNote: note,
    steps: (job.steps || []).map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
  };
}

function collectRun({ api, download, readReport, config, label, pair, runId }) {
  const repo = `${config.repo.owner}/${config.repo.name}`;
  const base = `repos/${repo}/actions`;
  const run = api(`${base}/runs/${runId}`);
  if (run.status !== 'completed') throw new Error(`run ${runId} is ${run.status}, not completed`);
  if (run.path !== config.workflow) {
    throw new Error(`run ${runId} is of ${run.path}, not of ${config.workflow}`);
  }
  const jobs = paginate(api, `${base}/runs/${runId}/jobs?filter=latest`, 'jobs');
  const artifacts = paginate(api, `${base}/runs/${runId}/artifacts`, 'artifacts');
  const shardJob = new RegExp(config.shardJobPattern);
  const blobName = new RegExp(config.blobArtifactPattern);

  const reduced = jobs.map((job) => {
    const ran =
      job.conclusion !== 'skipped' && job.runner_id !== null && job.runner_id !== undefined;
    if (!ran) return reduceJob(job, null);
    let text;
    try {
      text = download(`${base}/jobs/${job.id}/logs`).toString('utf8');
    } catch {
      // logs expire before artifacts do; the job keeps its timings and loses only its runner facts
      return reduceJob(job, null, 'the job log is no longer available');
    }
    return reduceJob(
      job,
      parseRunnerLog(text),
      job.conclusion === 'success' ? null : failureNote(text)
    );
  });

  const shards = [];
  for (const job of reduced) {
    const match = shardJob.exec(job.name);
    if (!match) continue;
    const index = Number(match[1]);
    const matching = artifacts.filter((a) => {
      const named = blobName.exec(a.name);
      return named && Number(named[1]) === index;
    });
    if (matching.length > 1)
      throw new Error(`shard ${index} has ${matching.length} blob artifacts`);
    const [artifact] = matching;
    const shard = { index, total: Number(match[2]), jobId: job.id, blob: null, blobMissing: null };
    if (!artifact) shard.blobMissing = 'no blob artifact was uploaded';
    else if (artifact.expired) shard.blobMissing = 'the blob artifact expired';
    else shard.blob = reduceBlob(readReport(download(`${base}/artifacts/${artifact.id}/zip`)));
    shards.push(shard);
  }
  if (shards.length === 0)
    throw new Error(`run ${runId} has no job named like ${config.shardJobPattern}`);
  shards.sort((a, b) => a.index - b.index);

  return {
    schema: SCHEMA,
    label,
    pair,
    labelNote: config.labels[label],
    repo: config.repo,
    workflow: config.workflow,
    testStep: config.testStep,
    facts: config.facts,
    serialSuites: config.serialSuites,
    run: {
      id: run.id,
      number: run.run_number,
      attempt: run.run_attempt,
      event: run.event,
      branch: run.head_branch,
      sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
      url: run.html_url,
    },
    jobs: reduced,
    shards,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  for (const required of ['config', 'label', 'pair', 'run', 'out']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.label)) throw new Error(`bad label ${args.label}`);
  for (const numeric of ['pair', 'run']) {
    if (!/^[1-9]\d*$/.test(args[numeric])) throw new Error(`--${numeric} must be a number`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const record = collectRun({
    api: ghApi,
    download: ghDownload,
    readReport: readReportText,
    config,
    label: args.label,
    pair: Number(args.pair),
    runId: args.run,
  });
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `${args.label}-${record.run.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(file);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  collectRun,
  failureNote,
  paginate,
  parseArgs,
  parseRunnerLog,
  readReportText,
  reduceJob,
};
