'use strict';

/**
 * Proofs 4 and 5: one assignment for every shard, and corrupt or mismatched input. These call
 * the engine on its own, without running Playwright, except for the per-shard recompute case.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { engineIds, listJson } = require('../playwright');
const { execute, filterProjects, plan, writeJson } = require('../drive');
const { assign } = require('../engine');
const { coverageKinds } = require('./coverage');

const SLOW_CLOCK = path.resolve(__dirname, '..', 'slow-clock.js');

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/** Whether an assignment covers `ids` exactly once across its shards. */
function completeness(assignment, ids) {
  const assigned = Object.values(assignment.shards).flat();
  const counts = new Map();
  for (const id of assigned) counts.set(id, (counts.get(id) || 0) + 1);
  return {
    complete: assigned.length === ids.length && ids.every((id) => counts.get(id) === 1),
    assigned: assigned.length,
    expected: ids.length,
  };
}

/** The chromium project's own tests as a list file, plus the engine ids of those tests. */
function chromiumList(ctx) {
  return ctx.once('assignment:list', () => {
    const json = filterProjects(listJson(ctx.cwd, ['--project=chromium']), ['chromium']);
    const file = writeJson(path.join(ctx.dir('assignment'), 'list-chromium.json'), json);
    return { file, ids: engineIds(json) };
  });
}

/** A deterministic synthetic timing file for `ids`, independent of any measurement. */
function syntheticTiming(ids, dir) {
  const tests = {};
  ids.forEach((id, index) => {
    tests[id] = {
      file: id.split('::')[0],
      duration: 100 + ((index * 37) % 900),
      runs: 3,
      lastRun: new Date().toISOString(),
    };
  });
  return writeJson(path.join(dir, 'synthetic-timing.json'), {
    version: 2,
    updatedAt: new Date().toISOString(),
    tests,
  });
}

function singleAssignment(ctx) {
  const list = chromiumList(ctx);
  const dir = ctx.dir('assignment');
  const timingFile = ctx.baseline().history.timing.chromium;
  const call = () => assign({ testList: list.file, shards: 3, timingFile });
  const runs = Array.from({ length: 5 }, call);
  const hashes = new Set(runs.map((run) => digest(run.assignment)));
  const first = runs[0].assignment;
  const synthetic = syntheticTiming(list.ids, dir);
  const missing = [];
  const differing = [2, 3, 4, 5].filter((shards) => {
    const input = { testList: list.file, shards, timingFile: synthetic };
    const real = assign(input).assignment;
    const slow = assign(input, { env: { NODE_OPTIONS: `--require "${SLOW_CLOCK}"` } }).assignment;
    if (!real || !slow) {
      missing.push(shards);
      return false;
    }
    return digest(real.shards) !== digest(slow.shards);
  });
  const answered = runs.every((run) => run.assignment) && missing.length === 0;
  const shape = first ? completeness(first, list.ids) : { complete: false };
  return {
    id: '4.single-assignment',
    proof: 4,
    title: 'one assign call yields the lists of all shards',
    status: answered && shape.complete && hashes.size === 1 ? 'pass' : 'fail',
    evidence: {
      ...shape,
      repeatedRuns: runs.length,
      distinctOutputs: hashes.size,
      outputKeys: Object.keys(first || {}).sort(),
      timingKeys: Object.keys(JSON.parse(fs.readFileSync(timingFile, 'utf8'))).sort(),
      shardCountsWhereSlowClockChangesAssignment: differing,
      shardCountsWithoutAnswer: missing,
    },
  };
}

function timingVariants(ctx) {
  const dir = ctx.dir('assignment');
  const source = fs.readFileSync(ctx.baseline().history.timing.chromium, 'utf8');
  const good = JSON.parse(source);
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const mapTests = (map) =>
    Object.fromEntries(Object.entries(good.tests).map(([id, entry]) => map(id, entry)));
  return {
    truncated: {
      files: [
        write('truncated.json', source.slice(0, 300)),
        write('empty.json', ''),
        path.join(dir, 'absent.json'),
      ],
    },
    version: { files: [write('old-version.json', { version: 1, tests: {} })] },
    nullTests: { files: [write('null-tests.json', { ...good, tests: null })] },
    stringDurations: {
      files: [
        write('string-durations.json', {
          ...good,
          tests: mapTests((id, e) => [id, { ...e, duration: 'abc' }]),
        }),
      ],
    },
    zeroDurations: {
      files: [
        write('zero-durations.json', {
          ...good,
          tests: mapTests((id, e) => [id, { ...e, duration: 0 }]),
        }),
      ],
    },
    staleIds: {
      files: [
        write('stale-ids.json', {
          ...good,
          tests: mapTests((id, e) => [`old-${id}`, { ...e, file: `old-${e.file}` }]),
        }),
      ],
    },
  };
}

/**
 * One damaged-input row. The engine is safe for this input when it either fails before any test
 * runs or answers with a complete assignment. `silent` marks an answer with no exit code and no
 * stderr text, so nothing tells the caller that the history was not used.
 */
function damagedRow(id, title, files, ids, list) {
  const outcomes = files.map((timingFile) => {
    const call = assign({ testList: list, shards: 2, timingFile });
    const failed = call.status !== 0;
    const shape = call.assignment ? completeness(call.assignment, ids) : null;
    return {
      file: path.basename(timingFile),
      exit: call.status,
      stderr: call.stderr.trim().split('\n')[0] || '',
      outcome: failed ? 'fails' : shape && shape.complete ? 'complete assignment' : 'incomplete',
      silent: !failed && call.stderr.trim() === '',
      estimated: call.assignment ? call.assignment.estimatedTests.length : null,
      isOptimal: call.assignment ? call.assignment.isOptimal : null,
      expectedDurations: call.assignment ? call.assignment.expectedDurations : null,
    };
  });
  const safe = outcomes.every((o) => o.outcome !== 'incomplete');
  return {
    id,
    proof: 5,
    title,
    status: safe ? 'pass' : 'fail',
    evidence: { total: ids.length, outcomes },
  };
}

function damagedTiming(ctx) {
  const list = chromiumList(ctx);
  const v = timingVariants(ctx);
  return [
    damagedRow(
      '5.truncated',
      'truncated, empty or missing timing file',
      v.truncated.files,
      list.ids,
      list.file
    ),
    damagedRow(
      '5.version',
      'timing file of another schema version',
      v.version.files,
      list.ids,
      list.file
    ),
    damagedRow(
      '5.null-tests',
      'valid JSON whose tests value is null',
      v.nullTests.files,
      list.ids,
      list.file
    ),
    damagedRow(
      '5.string-durations',
      'durations stored as text',
      v.stringDurations.files,
      list.ids,
      list.file
    ),
    damagedRow(
      '5.zero-durations',
      'every duration zero',
      v.zeroDurations.files,
      list.ids,
      list.file
    ),
    damagedRow(
      '5.stale-ids',
      'timing ids that match no listed test',
      v.staleIds.files,
      list.ids,
      list.file
    ),
  ];
}

/** One shard plans from a damaged timing file while the other plans from the good one. */
function recomputePerShard(ctx) {
  const timing = ctx.baseline().history.timing;
  const dir = ctx.dir('recompute');
  const damaged = path.join(dir, 'damaged.json');
  fs.writeFileSync(damaged, fs.readFileSync(timing.chromium, 'utf8').slice(0, 300));
  const listing = ctx.listing();
  const base = { cwd: ctx.cwd, flow: 'merged', shards: 2, listing };
  const good = plan({ ...base, dir: ctx.dir('recompute-good'), timing });
  const bad = plan({
    ...base,
    dir: ctx.dir('recompute-bad'),
    timing: { chromium: damaged, firefox: damaged },
  });
  const partition = [good.partition[0], bad.partition[1]];
  const run = execute({ cwd: ctx.cwd, partition, listing, workers: 4 });
  const found = coverageKinds(run.kinds);
  return {
    id: 'x1.recompute-per-shard',
    proof: 'x1',
    title: 'shard 1 plans from good history, shard 2 from a damaged copy',
    status: Object.keys(found).length === 0 ? 'pass' : 'fail',
    evidence: { coverageViolations: found, kinds: run.kinds },
  };
}

module.exports = {
  chromiumList,
  completeness,
  damagedTiming,
  recomputePerShard,
  singleAssignment,
  syntheticTiming,
};
