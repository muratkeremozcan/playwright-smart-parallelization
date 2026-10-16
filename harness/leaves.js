'use strict';

/**
 * Leaf model. A leaf is one test in one project at one repeat: the unit a partition must cover
 * exactly once. The harness reporter builds every leaf, in a list run and in a shard run alike, so
 * a key built from a listing and a key built from a run match by construction.
 */

const path = require('node:path');

const TITLE_SEPARATOR = ' › ';

function toPosix(file) {
  return String(file).split(path.sep).join('/').replace(/\\/g, '/');
}

/** Key shape: `project|file|titlePath joined by ' › '|#repeat`. */
function leafKey({ project, file, titlePath, repeatIndex }) {
  return `${project}|${file}|${titlePath.join(TITLE_SEPARATOR)}|#${repeatIndex}`;
}

/** The leaf key without the repeat suffix: one test across all of its repeats. */
function testId(leaf) {
  return leaf.key.replace(/\|#\d+$/, '');
}

/** The serial group id without the repeat suffix. */
function groupBase(group) {
  return group.replace(/\|#\d+$/, '');
}

/**
 * Picks the serial annotation that identifies a group. Nested serial describes nest the groups, so
 * the outermost one (the earliest location) is the unit that must stay on a single shard.
 */
function serialAnnotation(annotations, testDir) {
  const serial = (annotations || []).filter((a) => a && a.type === 'serial' && a.location);
  if (serial.length === 0) return null;
  serial.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
  const { file, line, column } = serial[0].location;
  return { file: toPosix(testDir ? path.relative(testDir, file) : file), line, column };
}

/** Serial group id: `project|annotation file|line:column|#repeat`, or null outside a serial suite. */
function serialGroupId({ project, annotations, testDir, repeatIndex }) {
  const found = serialAnnotation(annotations, testDir);
  if (!found) return null;
  return `${project}|${found.file}|${found.line}:${found.column}|#${repeatIndex}`;
}

function buildLeaf({ project, file, titlePath, repeatIndex, annotations, testDir, line, column }) {
  return {
    key: leafKey({ project, file, titlePath, repeatIndex }),
    file,
    project,
    titlePath,
    repeatIndex,
    serialGroup: serialGroupId({ project, annotations, testDir, repeatIndex }),
    dependency: false,
    line,
    column,
  };
}

/** Distinct project names that appear in a list of leaves. */
function projectsOf(leaves) {
  return [...new Set(leaves.map((leaf) => leaf.project))];
}

/**
 * For each project of the config, every project a run of it needs: its dependencies and their
 * teardowns, transitively. `projects` is `[{ name, dependencies, teardown }]` from the reporter.
 */
function dependencyMap(projects) {
  const byName = new Map(projects.map((project) => [project.name, project]));
  const needs = (name) => {
    const project = byName.get(name);
    return project
      ? [...project.dependencies, ...(project.teardown ? [project.teardown] : [])]
      : [];
  };
  const closure = (name, seen = new Set()) => {
    for (const next of needs(name)) {
      if (!seen.has(next)) {
        seen.add(next);
        closure(next, seen);
      }
    }
    return seen;
  };
  return Object.fromEntries(projects.map((project) => [project.name, [...closure(project.name)]]));
}

/** Projects that some other project depends on (setup and teardown). */
function dependencyProjects(dependencies) {
  return new Set(Object.values(dependencies).flat());
}

/**
 * Returns leaves with `dependency` set. This is the one classification rule. `leaves` is what
 * Playwright lists for the selection, filters and `--no-deps` already applied, so a project appears
 * in it only when a test of it survives, either because the selection keeps it or because another
 * listed project needs it. A leaf is a dependency, exempt from exactly-once coverage, only when
 * another listed project needs its project. Every other leaf is primary, which includes a setup or
 * teardown project the filters left standing on its own. A project a listed project pulled in is
 * needed by that project, and a project needed by a pulled-in one is needed by its puller too
 * (`dependencies` is transitive), so the pulled-in projects never change the answer.
 */
function classify(leaves, dependencies) {
  const present = projectsOf(leaves);
  const needed = new Set(
    present.flatMap((project) =>
      (dependencies[project] || []).filter((dependency) => dependency !== project)
    )
  );
  return leaves.map((leaf) => ({ ...leaf, dependency: needed.has(leaf.project) }));
}

/** A leaf as a listing knows it: the reporter's run fields (outcome, attempts, duration) dropped. */
function listedLeaf({ key, file, project, titlePath, repeatIndex, serialGroup, line, column }) {
  return {
    key,
    file,
    project,
    titlePath,
    repeatIndex,
    serialGroup,
    dependency: false,
    line,
    column,
  };
}

/** The `--list` text form of a leaf, the line format `--test-list` accepts. */
function listLine(leaf) {
  return `[${leaf.project}]${TITLE_SEPARATOR}${leaf.file}:${leaf.line}:${leaf.column}${TITLE_SEPARATOR}${leaf.titlePath.join(TITLE_SEPARATOR)}`;
}

module.exports = {
  TITLE_SEPARATOR,
  buildLeaf,
  classify,
  dependencyMap,
  dependencyProjects,
  groupBase,
  leafKey,
  listLine,
  listedLeaf,
  projectsOf,
  serialGroupId,
  testId,
  toPosix,
};
