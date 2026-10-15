'use strict';

/**
 * Integration shim that gives the engine projects and serial groups. The engine identifies a
 * test by file and title only and assigns single tests, so before `assign`:
 *
 *   - every file name gets its project as a prefix (`chromium/cart.spec.js`), so the same test
 *     in two projects is two tests and one `assign` call balances all projects together;
 *   - each serial group is presented as one test: the group's first member stands in for the
 *     group and carries the summed duration of all its members;
 *   - a test that `--repeat-each` lists several times is one test, because a `--test-list` line
 *     selects a test in all of its repeats.
 *
 * After `assign`, a stand-in is replaced by every member of its group and each line is turned
 * back into a Playwright test-list line with a `[project] ›` prefix.
 */

const fs = require('node:fs');
const path = require('node:path');
const { TITLE_SEPARATOR, groupBase, parseList } = require('../../harness/leaves');

const DEFAULT_MEMBER_MS = 30000;

/** The file name the engine sees for a leaf. */
function engineFile(leaf) {
  return `${leaf.project}/${leaf.file}`;
}

/** The engine's id for a leaf. */
function idOf(leaf) {
  return [engineFile(leaf), ...leaf.titlePath].join('::');
}

/** The test-list line the engine prints for a leaf. */
function lineOf(leaf) {
  return [engineFile(leaf), ...leaf.titlePath].join(TITLE_SEPARATOR);
}

/**
 * The Playwright test-list line that selects a leaf in its own project only. `prefix` is the
 * directory of the tests relative to the config directory, which Playwright matches files against.
 */
function playwrightLine(leaf, prefix = '') {
  const file = prefix ? `${prefix}/${leaf.file}` : leaf.file;
  return [`[${leaf.project}]`, file, ...leaf.titlePath].join(TITLE_SEPARATOR);
}

/**
 * The directory of the tests relative to the config directory, shared by all `projects`. The
 * engine puts it in front of every file name, and it reads it from the first project, so the
 * projects must agree.
 */
function testDirPrefix(config, projects) {
  const dirs = new Set(
    config.projects.filter((p) => projects.includes(p.name)).map((p) => p.testDir)
  );
  if (dirs.size !== 1) throw new Error('the projects do not share one testDir');
  const relative = path.relative(config.rootDir, [...dirs][0]);
  return relative.split(path.sep).join('/');
}

function specKey(project, file, line, column, title) {
  return `${project}|${file}|${line}|${column}|${title}`;
}

/** Serial groups with two or more members, each `{ representative, members }`. */
function serialGroups(leaves) {
  const groups = new Map();
  for (const leaf of leaves) {
    if (!leaf.serialGroup) continue;
    const id = groupBase(leaf.serialGroup);
    const members = groups.get(id) || [];
    members.push(leaf);
    groups.set(id, members);
  }
  return [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => ({ representative: members[0], members }));
}

/** Timing data of every project in one file, with ids and files namespaced by project. */
function mergeHistories(histories) {
  const tests = {};
  for (const [project, history] of Object.entries(histories)) {
    if (!history) continue;
    for (const [id, entry] of Object.entries(history.tests)) {
      tests[`${project}/${id}`] = { ...entry, file: `${project}/${entry.file}` };
    }
  }
  return { version: 2, updatedAt: new Date().toISOString(), tests };
}

/**
 * Returns `{ list, timing, groups, prefix }` for one `assign` call. `list` is the Playwright list JSON of
 * the primary projects (no dependency projects), `histories` maps a project to its parsed timing
 * data or null. The returned list holds namespaced files and only the stand-in of each group; the
 * timing is null when no project has history.
 */
function prepare(list, histories) {
  const leaves = parseList(list);
  const projects = [...new Set(leaves.map((leaf) => leaf.project))];
  const prefix = testDirPrefix(list.config, projects);
  const groups = serialGroups(leaves);
  const key = (leaf) =>
    specKey(leaf.project, leaf.file, leaf.line, leaf.column, leaf.titlePath.at(-1));
  const dropped = new Set(groups.flatMap(({ members }) => members.slice(1).map(key)));
  // A repeated test is listed once per repeat, so a member can share its location with the
  // stand-in, which must stay.
  for (const { representative } of groups) dropped.delete(key(representative));

  const seen = new Set();
  function rewrite(suite) {
    const specs = [];
    for (const spec of suite.specs || []) {
      const project = spec.tests[0].projectName;
      const file = spec.file || suite.file;
      const key = specKey(project, file, spec.line, spec.column, spec.title);
      if (dropped.has(key) || seen.has(key)) continue;
      seen.add(key);
      specs.push({ ...spec, file: `${project}/${file}` });
    }
    return { ...suite, specs, suites: (suite.suites || []).map(rewrite) };
  }

  const merged = mergeHistories(histories);
  let timing = null;
  if (Object.keys(merged.tests).length > 0) {
    timing = merged;
    for (const { representative, members } of groups) {
      const known = (leaf) => (merged.tests[idOf(leaf)] || {}).duration;
      const total = members.reduce((sum, leaf) => sum + (known(leaf) ?? DEFAULT_MEMBER_MS), 0);
      timing.tests[idOf(representative)] = {
        ...(merged.tests[idOf(representative)] || {
          file: engineFile(representative),
          runs: 1,
          lastRun: new Date().toISOString(),
        }),
        duration: total,
      };
    }
  }
  const config = {
    ...list.config,
    projects: list.config.projects.filter((p) => projects.includes(p.name)),
  };
  return { list: { ...list, config, suites: list.suites.map(rewrite) }, timing, groups, prefix };
}

/**
 * Turns an `assign` result into Playwright test-list lines: a stand-in is replaced by every
 * member of its group, and each line selects its test in its own project only.
 */
function finish(assignment, groups, leaves, prefix = '') {
  const byLine = new Map(leaves.map((leaf) => [lineOf(leaf), leaf]));
  const members = new Map(groups.map((g) => [lineOf(g.representative), g.members]));
  const testListFiles = {};
  for (const [shard, content] of Object.entries(assignment.testListFiles)) {
    const lines = content
      .split('\n')
      .filter(Boolean)
      .map((line) =>
        prefix && line.startsWith(`${prefix}/`) ? line.slice(prefix.length + 1) : line
      );
    const expanded = [
      ...new Set(
        lines.flatMap((line) => {
          const group = members.get(line);
          const found = group || [byLine.get(line)];
          if (found.some((leaf) => !leaf)) throw new Error(`unknown line in assignment: ${line}`);
          return found.map((leaf) => playwrightLine(leaf, prefix));
        })
      ),
    ];
    testListFiles[shard] = expanded.length === 0 ? '' : `${expanded.join('\n')}\n`;
  }
  return { ...assignment, testListFiles };
}

/** Reads a timing file, or null when `file` is empty. */
function readHistory(file) {
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

module.exports = {
  finish,
  idOf,
  lineOf,
  mergeHistories,
  playwrightLine,
  prepare,
  readHistory,
  serialGroups,
  testDirPrefix,
};
