'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeRun } = require('../analyze');
const {
  campaign,
  measure,
  nextPair,
  parseArgs,
  requireWarm,
  single,
  slotDone,
} = require('../dispatch');
const { armRecord, makeRecord, makeTest, standard } = require('./support');

const BASE = 'b'.repeat(40);
const MINIMUM = '0889051908c6078fff3f61321732418f2c29e973';
const HEAD = 'c'.repeat(40);
const T0 = Date.parse('2026-01-01T00:00:00Z');

const arm = (branch, phase = 'measured') => ({
  note: branch,
  branch,
  shards: 2,
  workers: 1,
  engine: 'native',
  phase,
  command: 'npx playwright test',
});

const config = {
  repo: { owner: 'o', name: 'r' },
  workflow: '.github/workflows/w.yml',
  base: BASE,
  minimumCommit: MINIMUM,
  control: 'control',
  pairs: 2,
  labels: {
    control: arm('psp/control'),
    one: arm('psp/one'),
    two: arm('psp/two'),
    'control-warmup': arm('psp/control', 'warm-up'),
    'one-warmup': arm('psp/one', 'warm-up'),
    'two-warmup': arm('psp/two', 'warm-up'),
  },
};

const iso = (ms) => new Date(ms).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
const records = (dir) =>
  fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));

/** A collected record of `label`; `outcome` is `timed`, `before-tests` or `in-tests`. */
function recordOf(label, pair, id, comparison, createdAt, outcome = 'timed') {
  const lean = { queue: 1000, setup: 1000, prepare: 0, server: 0, after: 0 };
  const first =
    outcome === 'before-tests'
      ? { ...lean, stoppedAt: 'Start local Supabase services', tests: [makeTest('t1', [1000])] }
      : {
          ...lean,
          tests: [makeTest('t1', [1000])],
          blobMissing: outcome === 'in-tests' ? 'no blob artifact was uploaded' : undefined,
        };
  const record = makeRecord({
    label,
    pair,
    id,
    shards: [first, { ...lean, tests: [makeTest('t2', [1000])] }],
    start: createdAt - T0,
  });
  record.run.branch = config.labels[label].branch;
  record.run.sha = HEAD;
  return armRecord(record, { phase: config.labels[label].phase, comparison });
}

/**
 * A fake GitHub. `active` lists are served in turn to the in_progress query, `listed` decides the
 * runs the workflow listing shows after a dispatch, and `outcome` decides each collected record.
 */
function fakeIo({
  active = [[]],
  compare = {},
  polls = 1,
  outcome = () => 'timed',
  listed,
  collectError,
  head = () => HEAD,
} = {}) {
  const calls = { dispatched: [], order: [], collected: [] };
  let activeIndex = 0;
  let statusReads = 0;
  let nextId = 500;
  let current = null;
  let clock = T0;
  const io = {
    api: (endpoint) => {
      if (/\/branches\//.test(endpoint)) {
        calls.order.push('head');
        return { commit: { sha: head() } };
      }
      const cmp = /\/compare\/([0-9a-f]+)\.\.\./.exec(endpoint);
      if (cmp) return compare[cmp[1]] || { status: 'ahead', ahead_by: 1, behind_by: 0 };
      if (/actions\/runs\?status=in_progress/.test(endpoint)) {
        const list = active[Math.min(activeIndex, active.length - 1)];
        activeIndex += 1;
        calls.order.push(list.length > 0 ? 'busy' : 'idle');
        return { workflow_runs: list };
      }
      if (/actions\/runs\?status=/.test(endpoint)) return { workflow_runs: [] };
      if (/actions\/runs\?created=/.test(endpoint)) {
        return {
          workflow_runs: [
            { id: current, created_at: iso(clock), updated_at: iso(clock + 600000) },
            { id: 7, path: 'o.yml', created_at: iso(clock + 1000), updated_at: iso(clock + 2000) },
            { id: 8, path: 'p.yml', created_at: iso(clock - 9e6), updated_at: iso(clock - 8e6) },
          ],
        };
      }
      if (/workflows\/w\.yml\/runs/.test(endpoint)) {
        const mine = { id: current, created_at: iso(clock), head_sha: HEAD, html_url: 'u' };
        return { workflow_runs: current ? (listed ? listed(mine, clock) : [mine]) : [] };
      }
      if (/actions\/runs\/\d+$/.test(endpoint)) {
        statusReads += 1;
        return {
          id: current,
          status: statusReads >= polls ? 'completed' : 'in_progress',
          conclusion: 'success',
          created_at: iso(clock),
          updated_at: iso(clock + 600000),
          head_sha: HEAD,
          head_branch: 'b',
          run_attempt: 1,
          event: 'workflow_dispatch',
          html_url: `https://example.test/runs/${current}`,
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    dispatch: (repo, workflow, branch) => {
      calls.dispatched.push(branch);
      calls.order.push('dispatch');
      clock += 15 * 60000;
      current = nextId;
      nextId += 1;
      statusReads = 0;
    },
    sleep: () => {},
    now: () => clock,
    log: () => {},
    collect: ({ label, pair, runId, comparison }) => {
      calls.collected.push(`${label}:${pair}`);
      if (collectError) throw new Error(collectError);
      const kind = outcome(label, pair, calls.collected.length);
      return recordOf(label, pair, Number(runId), comparison, clock, kind);
    },
  };
  return { io, calls };
}

/** A directory with one timed warm-up run on each branch at HEAD. */
function warmDir() {
  const dir = tmp();
  ['control-warmup', 'one-warmup', 'two-warmup'].forEach((label, i) => {
    const record = recordOf(label, 1, 900 + i, null, T0 - 3600000);
    fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(record));
  });
  return dir;
}

test('measure waits for runs in progress and reads the head only once the repository is idle', () => {
  const { io, calls } = fakeIo({ active: [[{ id: 1 }], [{ id: 1 }], []], polls: 2 });
  const out = tmp();
  const record = measure(io, config, { label: 'one', pair: 1, comparison: 'one' }, out);
  assert.equal(record.run.id, 500);
  assert.deepEqual(calls.order.slice(0, 6), ['busy', 'busy', 'idle', 'head', 'idle', 'dispatch']);
  assert.equal(record.dispatch.headSha, HEAD);
  assert.ok(fs.existsSync(path.join(out, 'one-500.json')));
});

test('measure proves the lineage of the head it read after the wait, before it dispatches', () => {
  const { io, calls } = fakeIo({
    active: [[{ id: 1 }], []],
    head: () => 'd'.repeat(40),
    compare: { [MINIMUM]: { status: 'behind', ahead_by: 0, behind_by: 2 } },
  });
  assert.throws(
    () => measure(io, config, { label: 'one', pair: 1, comparison: 'one' }, tmp()),
    /predates the minimum commit/
  );
  assert.deepEqual(calls.dispatched, []);
});

test('measure takes only the run created by its dispatch on the head it proved', () => {
  const listed = (mine, clock) => [
    { id: 41, created_at: iso(clock - 3600000), head_sha: HEAD, html_url: 'old' },
    { id: 42, created_at: iso(clock), head_sha: 'e'.repeat(40), html_url: 'other' },
    mine,
  ];
  const { io } = fakeIo({ listed });
  const record = measure(io, config, { label: 'one', pair: 1, comparison: 'one' }, tmp());
  assert.equal(record.run.id, 500);
});

test('measure refuses two runs for one dispatch and collects nothing', () => {
  const listed = (mine) => [mine, { ...mine, id: 501 }];
  const { io, calls } = fakeIo({ listed });
  assert.throws(
    () => measure(io, config, { label: 'one', pair: 1, comparison: 'one' }, tmp()),
    /2 runs appeared for one dispatch/
  );
  assert.deepEqual(calls.collected, []);
});

test('measure refuses a measured half without its comparison and a label that is not an arm', () => {
  const { io, calls } = fakeIo();
  assert.throws(
    () => measure(io, config, { label: 'one', pair: 1 }, tmp()),
    /needs the label it is paired for/
  );
  const legacy = { ...config, labels: { ...config.labels, old: 'a schema 1 label' } };
  assert.throws(() => measure(io, legacy, { label: 'old', pair: 1 }, tmp()), /not an arm/);
  assert.deepEqual(calls.dispatched, []);
});

test('a run the collector rejects is written as a stub with its reason', () => {
  const { io } = fakeIo({ collectError: 'run 500 has no job named like ^pw-e2e' });
  const out = tmp();
  measure(io, config, { label: 'one', pair: 1, comparison: 'one' }, out);
  const [stub] = records(out);
  assert.equal(stub.collectError, 'run 500 has no job named like ^pw-e2e');
  const run = analyzeRun(stub);
  assert.equal(run.cause, 'collect');
  assert.match(run.excluded, /not collected: run 500 has no job/);
});

test('measure records the other runs of the repository that overlapped its run', () => {
  const { io } = fakeIo();
  const record = measure(io, config, { label: 'one', pair: 1, comparison: 'one' }, tmp());
  assert.deepEqual(
    record.dispatch.overlapping.map((r) => r.id),
    [7]
  );
});

test('the campaign refuses to start before every branch has a warm-up run with timings at its head', () => {
  const { io, calls } = fakeIo();
  assert.throws(() => campaign(io, config, tmp()), /psp\/control has no warm-up run/);
  const dir = warmDir();
  fs.rmSync(path.join(dir, 'two-warmup.json'));
  assert.throws(() => campaign(io, config, dir), /psp\/two has no warm-up run/);
  const moved = fakeIo({ head: () => 'f'.repeat(40) });
  assert.throws(() => requireWarm(moved.io, config, records(warmDir())), /at ffffffffffff/);
  assert.deepEqual(calls.dispatched, []);
  assert.doesNotThrow(() => requireWarm(io, config, records(warmDir())));
});

test('the campaign alternates the order in pairs and rotates the arms between rounds', () => {
  const { io, calls } = fakeIo();
  campaign(io, config, warmDir());
  assert.deepEqual(calls.collected, [
    'control:1',
    'one:1',
    'two:1',
    'control:1',
    'control:2',
    'two:2',
    'one:2',
    'control:2',
  ]);
});

test('the campaign reruns a half that stopped before its tests, within the same pair', () => {
  const { io, calls } = fakeIo({
    outcome: (label, pair, n) => (n === 2 ? 'before-tests' : 'timed'),
  });
  campaign(io, config, warmDir());
  assert.deepEqual(calls.collected.slice(0, 3), ['control:1', 'one:1', 'one:1']);
  assert.equal(calls.collected.length, 9);
});

test('a half that stopped inside its tests breaks the pair, which stays, and the arm takes the next pair', () => {
  const { io, calls } = fakeIo({ outcome: (label, pair, n) => (n === 2 ? 'in-tests' : 'timed') });
  const out = warmDir();
  campaign(io, config, out);
  const ones = calls.collected.filter((c) => c.startsWith('one:'));
  assert.deepEqual(ones, ['one:1', 'one:2', 'one:3']);
  const kept = records(out).filter((r) => r.label === 'one' && r.pair === 1);
  assert.equal(kept.length, 1);
  assert.equal(analyzeRun(kept[0]).cause, 'in-tests');
});

test('the campaign stops a half that keeps stopping before its tests', () => {
  const { io, calls } = fakeIo({
    outcome: (label) => (label === 'one' ? 'before-tests' : 'timed'),
  });
  assert.throws(() => campaign(io, config, warmDir()), /one pair 1 has no timings after 3 runs/);
  assert.equal(calls.dispatched.length, 4);
});

test('the campaign stops an arm that keeps breaking its pairs', () => {
  const { io } = fakeIo({ outcome: (label) => (label === 'one' ? 'in-tests' : 'timed') });
  assert.throws(() => campaign(io, config, warmDir()), /one needs pair 6 for 2 matched pairs/);
});

test('nextPair stays on an open pair and moves past a matched, broken or stale one', () => {
  assert.equal(nextPair([]), 1);
  assert.equal(
    nextPair([
      { pair: 1, status: 'matched' },
      { pair: 2, status: 'open' },
    ]),
    2
  );
  for (const status of ['matched', 'broken', 'stale']) {
    assert.equal(nextPair([{ pair: 3, status }]), 4);
  }
});

test('slotDone counts only a record with timings for the same label, pair and comparison', () => {
  const timed = armRecord(standard({ label: 'control', pair: 1 }), { comparison: 'one' });
  assert.equal(slotDone([timed], { label: 'control', pair: 1, comparison: 'one' }), true);
  assert.equal(slotDone([timed], { label: 'control', pair: 1, comparison: 'two' }), false);
  assert.equal(slotDone([timed], { label: 'control', pair: 2, comparison: 'one' }), false);
});

test('a single run refuses a slot that already has timings', () => {
  const { io, calls } = fakeIo();
  const out = warmDir();
  assert.throws(
    () => single(io, config, { label: 'one-warmup', pair: 1 }, out),
    /already has a run with timings/
  );
  assert.deepEqual(calls.dispatched, []);
  single(io, config, { label: 'one-warmup', pair: 2 }, out);
  assert.deepEqual(calls.dispatched, ['psp/one']);
});

test('parseArgs needs a label and pair unless it runs the campaign', () => {
  assert.equal(parseArgs(['--config', 'c', '--out', 'o', '--campaign']).campaign, true);
  const one = ['--config', 'c', '--out', 'o', '--label', 'x', '--pair', '1'];
  assert.equal(parseArgs(one).label, 'x');
  assert.throws(() => parseArgs(['--config', 'c', '--out', 'o']), /--label and --pair/);
  assert.throws(() => parseArgs(['--out', 'o', '--campaign']), /--config is required/);
});
