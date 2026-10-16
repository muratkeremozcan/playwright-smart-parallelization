'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectRun,
  failureNote,
  paginate,
  parseArgs,
  parseRunnerLog,
  reduceJob,
} = require('../collect');

const config = {
  repo: { owner: 'o', name: 'r' },
  workflow: 'w.yml',
  labels: { x: 'a label' },
  shardJobPattern: '^pw-e2e \\((\\d+), (\\d+)\\)$',
  blobArtifactPattern: '^blob-report-(\\d+)$',
  testStep: 'Run suite',
  facts: { fullyParallel: true },
  serialSuites: [],
};

const LOG = [
  "2026-01-01T00:00:00Z Current runner version: '2.9.9'",
  '2026-01-01T00:00:00Z ##[group]Runner Image Provisioner',
  '2026-01-01T00:00:00Z Hosted Compute Agent',
  '2026-01-01T00:00:00Z Region: westus',
  '2026-01-01T00:00:00Z ##[endgroup]',
  '2026-01-01T00:00:00Z ##[group]Operating System',
  '2026-01-01T00:00:00Z Ubuntu',
  '2026-01-01T00:00:00Z 24.04.5',
  '2026-01-01T00:00:00Z ##[endgroup]',
  '2026-01-01T00:00:00Z ##[group]Runner Image',
  '2026-01-01T00:00:00Z Image: ubuntu-24.04',
  '2026-01-01T00:00:00Z Version: 2026.1.1',
  '2026-01-01T00:00:00Z ##[endgroup]',
  '2026-01-01T00:00:00Z Region: elsewhere',
].join('\n');

test('parseRunnerLog reads the runner and image lines and leaves absent ones null', () => {
  assert.deepEqual(parseRunnerLog(LOG), {
    runnerVersion: '2.9.9',
    image: 'ubuntu-24.04',
    imageVersion: '2026.1.1',
    os: 'Ubuntu',
    osVersion: '24.04.5',
    region: 'westus',
  });
  assert.equal(parseRunnerLog('nothing here').image, null);
});

test('paginate reads every page and checks the count', () => {
  const pages = {
    1: { total_count: 5, jobs: [1, 2] },
    2: { total_count: 5, jobs: [3, 4] },
    3: { total_count: 5, jobs: [5] },
  };
  const asked = [];
  const api = (endpoint) => {
    asked.push(endpoint);
    return pages[/&page=(\d+)$/.exec(endpoint)[1]];
  };
  assert.deepEqual(paginate(api, 'x/jobs?filter=latest', 'jobs'), [1, 2, 3, 4, 5]);
  assert.equal(asked.length, 3);
  assert.match(asked[0], /^x\/jobs\?filter=latest&per_page=100&page=1$/);
});

test('paginate throws when the API lists fewer items than it reports', () => {
  const api = (endpoint) => ({ total_count: 3, jobs: /&page=1$/.test(endpoint) ? [1, 2] : [] });
  assert.throws(() => paginate(api, 'x/jobs', 'jobs'), /reports 3/);
  assert.throws(() => paginate(() => ({ jobs: [] }), 'x/jobs', 'jobs'), /total_count/);
});

test('reduceJob keeps a job without steps and drops the runner identity', () => {
  const reduced = reduceJob(
    {
      id: 1,
      name: 'n',
      status: 'completed',
      conclusion: 'cancelled',
      created_at: 'c',
      started_at: 's',
      completed_at: 'e',
      labels: [],
      runner_name: 'GitHub Actions 1',
    },
    null
  );
  assert.deepEqual(reduced.steps, []);
  assert.equal('runner_name' in reduced, false);
  assert.equal(JSON.stringify(reduced).includes('GitHub Actions 1'), false);
});

function job(id, name, extra = {}) {
  return {
    id,
    name,
    status: 'completed',
    conclusion: 'success',
    runner_id: id,
    created_at: 'a',
    started_at: 'b',
    completed_at: 'c',
    labels: ['ubuntu-latest'],
    steps: [],
    ...extra,
  };
}

function harness({ artifacts, jobs }) {
  const logged = [];
  const api = (endpoint) => {
    if (/\/jobs\?/.test(endpoint)) return { total_count: jobs.length, jobs };
    if (/\/artifacts\?/.test(endpoint)) return { total_count: artifacts.length, artifacts };
    return {
      id: 9,
      path: 'w.yml',
      run_number: 1,
      run_attempt: 1,
      event: 'workflow_dispatch',
      head_branch: 'b',
      head_sha: 's',
      status: 'completed',
      conclusion: 'success',
      created_at: 'a',
      run_started_at: 'a',
      updated_at: 'a',
      html_url: 'u',
    };
  };
  const download = (endpoint) => {
    logged.push(endpoint);
    return Buffer.from(endpoint.endsWith('/logs') ? LOG : endpoint);
  };
  const readReport = (zip) => {
    const id = zip.toString();
    return [
      {
        method: 'onBlobReportMetadata',
        params: {
          userAgent: 'node/24.1',
          shard: { current: Number(/artifacts\/(\d)/.exec(id)[1]), total: 2 },
        },
      },
      { method: 'onConfigure', params: { config: { version: '1.0.0', workers: 1 } } },
      { method: 'onEnd', params: { result: { startTime: 1, duration: 2 } } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
  };
  return { api, download, readReport, logged };
}

test('collectRun maps blob artifacts to shard jobs, flags missing and expired ones, skips skipped jobs', () => {
  const h = harness({
    jobs: [
      job(1, 'vars'),
      job(2, 'pw-e2e (1, 2)'),
      job(3, 'pw-e2e (2, 2)'),
      job(4, 'burn-in', { conclusion: 'skipped', runner_id: null }),
    ],
    artifacts: [
      { id: 1, name: 'blob-report-1', expired: false },
      { id: 2, name: 'blob-report-2', expired: true },
    ],
  });
  const record = collectRun({ ...h, config, label: 'x', pair: 1, runId: 9 });
  assert.equal(record.shards[0].blob.shard.current, 1);
  assert.equal(record.shards[1].blob, null);
  assert.equal(record.shards[1].blobMissing, 'the blob artifact expired');
  assert.equal(h.logged.filter((e) => e.endsWith('/logs')).length, 3);
  assert.equal(record.jobs.find((j) => j.name === 'burn-in').runner, null);
  assert.equal(record.testStep, 'Run suite');
});

test('collectRun records a shard whose artifact was never uploaded and refuses an unfinished run', () => {
  const h = harness({
    jobs: [job(2, 'pw-e2e (1, 2)'), job(3, 'pw-e2e (2, 2)')],
    artifacts: [{ id: 1, name: 'blob-report-1', expired: false }],
  });
  const record = collectRun({ ...h, config, label: 'x', pair: 1, runId: 9 });
  assert.equal(record.shards[1].blobMissing, 'no blob artifact was uploaded');
  const api = (e) => ({ ...h.api(e), status: 'in_progress' });
  assert.throws(
    () => collectRun({ ...h, api, config, label: 'x', pair: 1, runId: 9 }),
    /not completed/
  );
});

test('readReportText unpacks report.jsonl from the nested blob zips', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { readReportText } = require('../collect');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-'));
  try {
    const inner = path.join(dir, 'inner');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'report.jsonl'), '{"method":"onEnd"}\n');
    execFileSync('zip', [
      '-q',
      '-j',
      path.join(dir, 'report-1.zip'),
      path.join(inner, 'report.jsonl'),
    ]);
    execFileSync('zip', [
      '-q',
      '-j',
      path.join(dir, 'artifact.zip'),
      path.join(dir, 'report-1.zip'),
    ]);
    assert.equal(
      readReportText(fs.readFileSync(path.join(dir, 'artifact.zip'))),
      '{"method":"onEnd"}\n'
    );
    execFileSync('zip', [
      '-q',
      '-j',
      path.join(dir, 'two.zip'),
      path.join(dir, 'report-1.zip'),
      path.join(inner, 'report.jsonl'),
    ]);
    fs.copyFileSync(path.join(dir, 'report-1.zip'), path.join(dir, 'report-2.zip'));
    execFileSync('zip', ['-q', '-j', path.join(dir, 'two.zip'), path.join(dir, 'report-2.zip')]);
    assert.throws(() => readReportText(fs.readFileSync(path.join(dir, 'two.zip'))), /found 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failureNote returns the first Error line of a log without its timestamp', () => {
  const log = [
    '2026-01-01T00:00:00.1Z ::error::Failed to start',
    '2026-01-01T00:00:01.2Z  studio Error toomanyrequests: Data limit exceeded',
    '2026-01-01T00:00:02.3Z  realtime Error toomanyrequests: Data limit exceeded',
  ].join('\n');
  assert.equal(failureNote(log), 'studio Error toomanyrequests: Data limit exceeded');
  assert.equal(failureNote('2026-01-01T00:00:00Z all fine'), null);
});

test('collectRun keeps the failure note of a job that did not succeed', () => {
  const h = harness({
    jobs: [job(2, 'pw-e2e (1, 2)', { conclusion: 'cancelled' }), job(3, 'pw-e2e (2, 2)')],
    artifacts: [],
  });
  const download = (endpoint) =>
    endpoint.endsWith('/logs')
      ? Buffer.from(`${LOG}\n2026-01-01T00:00:00Z  kong Error toomanyrequests`)
      : h.download(endpoint);
  const record = collectRun({ ...h, download, config, label: 'x', pair: 1, runId: 9 });
  assert.equal(record.jobs[0].failureNote, 'kong Error toomanyrequests');
  assert.equal(record.jobs[1].failureNote, null);
});

test('collectRun refuses a run of another workflow and a run without shard jobs', () => {
  const h = harness({ jobs: [job(1, 'vars')], artifacts: [] });
  assert.throws(
    () => collectRun({ ...h, config, label: 'x', pair: 1, runId: 9 }),
    /no job named like/
  );
  const other = (e) => ({ ...h.api(e), path: 'other.yml' });
  assert.throws(
    () => collectRun({ ...h, api: other, config, label: 'x', pair: 1, runId: 9 }),
    /not of w\.yml/
  );
});

test('collectRun refuses two blob artifacts for one shard', () => {
  const h = harness({
    jobs: [job(2, 'pw-e2e (1, 2)'), job(3, 'pw-e2e (2, 2)')],
    artifacts: [
      { id: 1, name: 'blob-report-1', expired: false },
      { id: 5, name: 'blob-report-1', expired: false },
    ],
  });
  assert.throws(
    () => collectRun({ ...h, config, label: 'x', pair: 1, runId: 9 }),
    /2 blob artifacts/
  );
});

test('collectRun keeps a job whose log has expired', () => {
  const h = harness({ jobs: [job(2, 'pw-e2e (1, 2)'), job(3, 'pw-e2e (2, 2)')], artifacts: [] });
  const download = (endpoint) => {
    if (endpoint.endsWith('/logs')) throw new Error('410 gone');
    return h.download(endpoint);
  };
  const record = collectRun({ ...h, download, config, label: 'x', pair: 1, runId: 9 });
  assert.equal(record.jobs[0].runner, null);
  assert.equal(record.jobs[0].failureNote, 'the job log is no longer available');
  assert.equal(record.pair, 1);
  assert.equal(record.labelNote, 'a label');
});

test('parseArgs requires every option and rejects a label or number that is not plain', () => {
  const ok = ['--config', 'c', '--label', 'baseline-a', '--pair', '2', '--run', '9', '--out', 'o'];
  assert.equal(parseArgs(ok).label, 'baseline-a');
  const without = (name) => {
    const i = ok.indexOf(name);
    return [...ok.slice(0, i), ...ok.slice(i + 2)];
  };
  for (const name of ['--config', '--label', '--pair', '--run', '--out']) {
    assert.throws(() => parseArgs(without(name)), /is required/);
  }
  assert.throws(() => parseArgs(['--label', '../x', ...without('--label')]), /bad label/);
  assert.throws(() => parseArgs(['--run', 'abc', ...without('--run')]), /must be a number/);
  assert.throws(() => parseArgs(['--pair', '0', ...without('--pair')]), /must be a number/);
  assert.throws(() => parseArgs(['--oops']), /bad argument/);
});

const BASE = 'b'.repeat(40);
const MINIMUM = '0889051908c6078fff3f61321732418f2c29e973';
const HEAD = 'c'.repeat(40);

const armConfig = {
  ...config,
  base: BASE,
  minimumCommit: MINIMUM,
  resolvedPackages: ['@playwright/test', '@flakiness/playwright'],
  labels: {
    x: 'a label',
    flk: {
      note: 'balanced',
      branch: 'b',
      shards: 2,
      workers: 1,
      engine: 'flakiness',
      phase: 'measured',
      command: 'npx playwright test',
    },
  },
};

/** The run harness plus the compare API and a lockfile, as the arm path reads them. */
function armHarness({ compare = {}, lock } = {}) {
  const h = harness({
    jobs: [job(2, 'pw-e2e (1, 2)'), job(3, 'pw-e2e (2, 2)'), job(4, 'merge-reports')],
    artifacts: [
      { id: 1, name: 'blob-report-1', expired: false },
      { id: 2, name: 'blob-report-2', expired: false },
    ],
  });
  const asked = [];
  const api = (endpoint) => {
    const match = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(endpoint);
    if (match) {
      asked.push(endpoint);
      return compare[match[1]] || { status: 'ahead', ahead_by: 1, behind_by: 0 };
    }
    return { ...h.api(endpoint), head_sha: HEAD };
  };
  const download = (endpoint) =>
    /jobs\/[234]\/logs$/.test(endpoint)
      ? Buffer.from(
          `${LOG}\n2026-01-01T00:00:01Z [flakiness.io]   duration hints: 160/160 tests (100%)\n2026-01-01T00:00:02Z other line`
        )
      : h.download(endpoint);
  const raw = (endpoint) => {
    // the versions must come from the run's own commit
    assert.match(endpoint, new RegExp(`contents/package-lock\\.json\\?ref=${HEAD}$`));
    return JSON.stringify(
      lock || {
        packages: {
          'node_modules/@playwright/test': { version: '1.64.1' },
        },
      }
    );
  };
  return { ...h, api, download, raw, asked };
}

test('collectRun writes an arm record with its lineage, versions and engine lines', () => {
  const h = armHarness();
  const record = collectRun({
    ...h,
    config: armConfig,
    label: 'flk',
    pair: 2,
    runId: 9,
    comparison: 'flk',
  });
  assert.equal(record.schema, 2);
  assert.equal(record.comparison, 'flk');
  assert.deepEqual(record.arm, {
    branch: 'b',
    shards: 2,
    workers: 1,
    engine: 'flakiness',
    phase: 'measured',
    command: 'npx playwright test',
    stressOf: null,
  });
  assert.deepEqual(record.base, { sha: BASE, aheadBy: 1, minimum: MINIMUM, fromMinimum: true });
  assert.deepEqual(record.resolved, {
    '@playwright/test': '1.64.1',
    '@flakiness/playwright': null,
  });
  const shardJob = record.jobs.find((j) => j.name === 'pw-e2e (1, 2)');
  assert.deepEqual(shardJob.engineLines, ['[flakiness.io]   duration hints: 160/160 tests (100%)']);
  assert.equal(record.jobs.find((j) => j.name === 'merge-reports').engineLines, null);
  assert.equal(h.asked.length, 2);
});

test('collectRun refuses an arm run that predates the minimum commit, leaves the base or ran elsewhere', () => {
  const behind = { status: 'behind', ahead_by: 0, behind_by: 3 };
  const diverged = { status: 'diverged', ahead_by: 2, behind_by: 1 };
  const run =
    (h, extra = {}) =>
    () =>
      collectRun({ ...h, config: { ...armConfig, ...extra }, label: 'flk', pair: 1, runId: 9 });
  assert.throws(run(armHarness({ compare: { [MINIMUM]: behind } })), /predates the minimum commit/);
  assert.throws(
    run(armHarness({ compare: { [MINIMUM]: diverged } })),
    /predates the minimum commit/
  );
  assert.throws(
    run(armHarness({ compare: { [BASE]: diverged } })),
    /does not descend from the base/
  );
  assert.throws(run(armHarness(), { base: 'short' }), /config\.base must be a full commit sha/);
  const other = { ...armConfig.labels.flk, branch: 'elsewhere' };
  assert.throws(
    run(armHarness(), { labels: { ...armConfig.labels, flk: other } }),
    /ran on b, the arm flk is elsewhere/
  );
  assert.throws(
    () => collectRun({ ...armHarness(), config: armConfig, label: 'nope', pair: 1, runId: 9 }),
    /not in the config/
  );
});

test('a schema 1 label keeps the S5 record shape', () => {
  const record = collectRun({ ...armHarness(), config: armConfig, label: 'x', pair: 1, runId: 9 });
  assert.equal(record.schema, 1);
  assert.equal(record.arm, undefined);
  assert.equal(record.base, undefined);
});

test('engineLines keeps only engine lines, without timestamps, and null when there are none', () => {
  const { engineLines } = require('../collect');
  assert.deepEqual(
    engineLines('2026-01-01T00:00:00Z [flakiness.io] balancing 2 shards\n2026-01-01T00:00:00Z x'),
    ['[flakiness.io] balancing 2 shards']
  );
  assert.equal(engineLines('2026-01-01T00:00:00Z nothing'), null);
});

test('parseArgs accepts a plain comparison label and rejects another', () => {
  const ok = ['--config', 'c', '--label', 'a', '--pair', '2', '--run', '9', '--out', 'o'];
  assert.equal(parseArgs([...ok, '--comparison', 'shards-3']).comparison, 'shards-3');
  assert.throws(() => parseArgs([...ok, '--comparison', '../x']), /bad comparison/);
});
