'use strict';

/**
 * Drives the engine against a consumer project through the S2 harness. Four flows turn engine
 * assignments into harness partitions (`{ args, env }` shards):
 *
 *   combined  one list for the whole config, one assignment, `--test-list` per shard, exactly as
 *             the package Quick Start does for a default config.
 *   jobs      one list, assignment and set of jobs per project, `--test-list` plus `--project`,
 *             the per-project usage the package documents.
 *   merged    one assignment per project, merged into one test-list file per shard with a
 *             `[project] ›` prefix on every line, so a shard still runs all projects in one
 *             Playwright invocation, like native sharding.
 *   grouped   one assignment for all projects through the shim of `shim.js`: files carry their
 *             project and each serial group is handed to the engine as one test.
 *
 * Timing history is built from the Playwright JSON reports of harness runs: `extract-timing`
 * on each shard report, then `merge-timing`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TITLE_SEPARATOR, dependencyProjects } = require('../../harness/leaves');
const { listIntended, listJson, qualify } = require('../../harness');
const { parseList } = require('../../harness/leaves');
const { assign, extractTiming, mergeTiming } = require('./engine');
const shim = require('./shim');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `psp-nsx-${prefix}-`));
}

/**
 * Copies a consumer project into `dir` and applies `edits`, a map from a project-relative path to
 * new file content (or null to delete the file). The copy shares the original `node_modules`.
 * Returns the path of the copy.
 */
function copyProject(source, dir, edits = {}) {
  const target = path.join(dir, 'project');
  const skipped = new Set(['node_modules', 'test-results', 'playwright-report', 'blob-report']);
  fs.cpSync(source, target, {
    recursive: true,
    filter: (file) => !skipped.has(path.basename(file)),
  });
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(target, 'node_modules'));
  for (const [relative, content] of Object.entries(edits)) {
    const file = path.join(target, relative);
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
  return target;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** Primary (non-dependency) project names of a listing, in declaration order. */
function primaryProjects(listing) {
  return [
    ...new Set(listing.leaves.filter((leaf) => !leaf.dependency).map((leaf) => leaf.project)),
  ];
}

/** A copy of a Playwright JSON list or report with only the tests of `keep` projects. */
function filterProjects(json, keep) {
  const wanted = new Set(keep);
  function filterSuite(suite) {
    return {
      ...suite,
      specs: (suite.specs || [])
        .map((spec) => ({ ...spec, tests: spec.tests.filter((t) => wanted.has(t.projectName)) }))
        .filter((spec) => spec.tests.length > 0),
      suites: (suite.suites || []).map(filterSuite),
    };
  }
  return { ...json, suites: json.suites.map(filterSuite) };
}

function writeTestList(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** Shard test-list lines of an assignment, with an optional `[project] ›` prefix. */
function assignmentLines(assignment, shard, project) {
  const content = assignment.testListFiles[shard] || '';
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => (project ? `[${project}]${TITLE_SEPARATOR}${line}` : line));
}

/** The engine call options for one plan: shards, timing file and assign flags. */
function assignInput(options, testList, project) {
  const timing = options.timing && (project ? options.timing[project] : options.timing.all);
  return { testList, shards: options.shards, timingFile: timing, ...options.assign };
}

/**
 * Plans a run with the engine and returns `{ partition, assignments, planMs }`. `options`:
 * `{ cwd, dir, flow, shards, forward, repeatEach, listing, timing, assign, engine }` where
 * `timing` maps a project name (or `all`) to a timing file, `assign` holds extra `assign` flags
 * and `engine` the `runEngine` options (network wrap and guard).
 */
function plan(options) {
  const { cwd, dir, flow, shards, forward = [], repeatEach = 1, engine = {} } = options;
  const base = [`--repeat-each=${repeatEach}`, ...forward];
  const started = Date.now();
  const assignments = {};

  if (flow === 'combined') {
    const testList = writeJson(path.join(dir, 'list-all.json'), listJson(cwd, base));
    assignments.all = assign(assignInput(options, testList), engine);
  } else if (flow === 'grouped') {
    const listing = options.listing || listIntended({ cwd, repeatEach, forward });
    assignments.all = assignGrouped({ options, listing, json: listJson(cwd, base), dir, engine });
  } else {
    const listing = options.listing || listIntended({ cwd, repeatEach, forward });
    for (const project of primaryProjects(listing)) {
      const json = listJson(cwd, [...base, `--project=${project}`]);
      if (flow === 'jobs') {
        const testList = writeJson(path.join(dir, `list-${project}.json`), json);
        assignments[project] = assign(
          { ...assignInput(options, testList, project), project },
          engine
        );
      } else {
        assignments[project] = assignProject({ options, json, project, dir, engine });
      }
    }
  }

  for (const [name, result] of Object.entries(assignments)) {
    if (result.status !== 0 || !result.assignment) {
      throw new Error(`assign failed for ${name} (exit ${result.status}): ${result.stderr}`);
    }
  }
  const planMs = Date.now() - started;
  return { partition: partitionOf(flow, assignments, shards, dir), assignments, planMs };
}

/** Assigns one project's own tests. */
function assignProject({ options, json, project, dir, engine }) {
  const testList = writeJson(
    path.join(dir, `list-${project}.json`),
    filterProjects(json, [project])
  );
  return assign({ ...assignInput(options, testList, project), project }, engine);
}

/**
 * One `assign` call for all primary projects, through the shim: files carry their project and a
 * serial group is one test. The assignment comes back as Playwright test-list lines.
 */
function assignGrouped({ options, listing, json, dir, engine }) {
  const projects = primaryProjects(listing);
  const own = filterProjects(json, projects);
  const histories = Object.fromEntries(
    projects.map((project) => [
      project,
      shim.readHistory(options.timing && options.timing[project]),
    ])
  );
  const prepared = shim.prepare(own, histories);
  const input = { testList: writeJson(path.join(dir, 'list-grouped.json'), prepared.list) };
  input.shards = options.shards;
  if (prepared.timing)
    input.timingFile = writeJson(path.join(dir, 'timing-grouped.json'), prepared.timing);
  const result = assign({ ...input, ...options.assign }, engine);
  if (result.assignment) {
    result.assignment = shim.finish(
      result.assignment,
      prepared.groups,
      parseList(own),
      prepared.prefix
    );
  }
  return result;
}

function partitionOf(flow, assignments, shards, dir) {
  if (flow === 'combined' || flow === 'grouped') {
    return Array.from({ length: shards }, (_, index) => {
      const lines = assignmentLines(assignments.all.assignment, index + 1);
      return {
        args: [
          '--test-list',
          writeTestList(dir, `shard-${index + 1}.txt`, `${lines.join('\n')}\n`),
        ],
      };
    });
  }
  if (flow === 'jobs') {
    return Object.entries(assignments).flatMap(([project, result]) =>
      Array.from({ length: shards }, (_, index) => {
        const lines = assignmentLines(result.assignment, index + 1);
        const file = writeTestList(
          dir,
          `${project}-shard-${index + 1}.txt`,
          `${lines.join('\n')}\n`
        );
        return { args: ['--test-list', file, `--project=${project}`] };
      })
    );
  }
  return Array.from({ length: shards }, (_, index) => {
    const lines = Object.entries(assignments).flatMap(([project, result]) =>
      assignmentLines(result.assignment, index + 1, project)
    );
    return {
      args: ['--test-list', writeTestList(dir, `shard-${index + 1}.txt`, `${lines.join('\n')}\n`)],
    };
  });
}

/**
 * Adds a JSON report (and with `blob` a blob report) per shard, written under `dir`. With
 * `output`, each shard also gets its own Playwright output directory, so attachments and traces
 * of one shard are not cleared by the next.
 */
function withReports(partition, dir, { blob = false, output = false } = {}) {
  return partition.map((shard, index) => ({
    args: [
      ...shard.args,
      `--reporter=${blob ? 'json,blob' : 'json'}`,
      ...(output ? [`--output=${path.join(dir, `results-${index + 1}`)}`] : []),
    ],
    env: {
      ...shard.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(dir, `report-${index + 1}.json`),
      ...(blob ? { PLAYWRIGHT_BLOB_OUTPUT_DIR: path.join(dir, `blob-${index + 1}`) } : {}),
    },
  }));
}

/** Paths of the JSON reports `withReports` asked for that exist after the run. */
function reportFiles(partition) {
  return partition
    .map((shard) => shard.env && shard.env.PLAYWRIGHT_JSON_OUTPUT_FILE)
    .filter((file) => file && fs.existsSync(file));
}

/** Violation counts by kind. */
function violationKinds(report) {
  const counts = {};
  for (const violation of report.violations) {
    counts[violation.kind] = (counts[violation.kind] || 0) + 1;
  }
  return counts;
}

/** Runs the harness over a partition and returns the report plus the violation counts. */
function execute({ cwd, partition, listing, repeatEach = 1, workers = 1, forward = [] }) {
  const report = qualify(
    { cwd, partition, listing, repeatEach, workers, forward },
    { quiet: true }
  );
  return { report, kinds: violationKinds(report) };
}

/** Rounds every duration in a history file to a multiple of `step` ms. */
function roundDurations(file, step) {
  const history = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of Object.values(history.tests)) {
    entry.duration = Math.round(entry.duration / step) * step;
  }
  fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

/**
 * Builds timing history files from Playwright JSON reports. Returns a map from each project (and
 * `all`, the whole report with no project split) to a history file in `dir`, plus the engine call
 * results for the footprint numbers. With `roundMs` the merged durations are rounded to a multiple
 * of it, so that the assignment does not depend on a few milliseconds of run-to-run noise.
 * `existing` maps a project (or `all`) to a history file the
 * new observations are merged into.
 */
function buildHistory({ dir, reports, listing, existing = {}, roundMs, engine = {} }) {
  const dependencies = [...dependencyProjects(listing.dependencies)];
  const timing = {};
  const calls = { extract: [], merge: [] };
  const targets = [
    ...primaryProjects(listing).map((project) => ({ project, keep: [project, ...dependencies] })),
    { project: 'all', keep: null },
  ];

  for (const { project, keep } of targets) {
    const artifacts = reports.map((reportFile, index) => {
      const source = keep
        ? writeJson(
            path.join(dir, `filtered-${project}-${index + 1}.json`),
            filterProjects(JSON.parse(fs.readFileSync(reportFile, 'utf8')), keep)
          )
        : reportFile;
      const outputFile = path.join(dir, `timing-${project}-shard-${index + 1}.json`);
      const call = extractTiming(
        {
          reportFile: source,
          outputFile,
          project: project === 'all' ? primaryProjects(listing)[0] : project,
          shard: index + 1,
        },
        engine
      );
      if (call.status !== 0) throw new Error(`extract-timing failed: ${call.stderr}`);
      calls.extract.push(call);
      return outputFile;
    });
    const output = path.join(dir, `timing-${project}.json`);
    const merged = mergeTiming({ existing: existing[project], artifacts, output }, engine);
    if (merged.status !== 0) throw new Error(`merge-timing failed: ${merged.stderr}`);
    calls.merge.push(merged);
    if (roundMs) roundDurations(output, roundMs);
    timing[project] = output;
  }
  return { timing, calls };
}

module.exports = {
  assignmentLines,
  copyProject,
  buildHistory,
  execute,
  filterProjects,
  partitionOf,
  plan,
  primaryProjects,
  reportFiles,
  tempDir,
  violationKinds,
  withReports,
  writeJson,
};
