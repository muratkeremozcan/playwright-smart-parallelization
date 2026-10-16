'use strict';

/**
 * Leaf model. A leaf is one test in one project at one repeat: the unit a partition must cover
 * exactly once. The harness reporter builds every leaf, in a list run and in a shard run alike, so
 * a key built from a listing and a key built from a run match by construction.
 */

const path = require('node:path');

const TITLE_SEPARATOR = ' › ';
// A title no test has, for list lines that only load a file.
const LOAD_ONLY_TITLE = '\u0000load only';

function toPosix(file) {
  return String(file).split(path.sep).join('/').replace(/\\/g, '/');
}

/** The human-readable name of a leaf: `project|file|titlePath joined by ' › '|#repeat`. */
function leafLabel({ project, specFile, titlePath, repeatIndex }) {
  return `${project}|${specFile}|${titlePath.join(TITLE_SEPARATOR)}|#${repeatIndex}`;
}

/** The serial group id without the repeat suffix. */
function groupBase(group) {
  return group.replace(/\|#\d+$/, '');
}

/**
 * Serial group id: `project|spec file|suite titles|#repeat`. The suite is the outermost serial
 * suite of the test, found by the reporter from the suite ancestry. Unlike a call site, its titles
 * tell apart sibling suites that one helper builds.
 */
function serialGroupId({ project, specFile, suiteTitles, repeatIndex }) {
  return `${project}|${specFile}|${suiteTitles.join(TITLE_SEPARATOR)}|#${repeatIndex}`;
}

/**
 * Builds a leaf. `id` is Playwright's own test id, unique per project, spec file, title path and
 * repeat, and it is the leaf key: a key from the call location collides when a helper registers
 * the same tests for several spec files, the id cannot. `label` is the readable
 * name used in output, `testRef` names one test across its repeats, and `file` with `line` and
 * `column` is the location of the test call for the `--test-list` form.
 */
function buildLeaf({
  id,
  project,
  specFile,
  file,
  titlePath,
  repeatIndex,
  serialGroup,
  line,
  column,
}) {
  return {
    key: id,
    label: leafLabel({ project, specFile, titlePath, repeatIndex }),
    testRef: `${project}|${specFile}|${titlePath.join(TITLE_SEPARATOR)}`,
    file,
    specFile,
    project,
    titlePath,
    repeatIndex,
    serialGroup,
    dependency: false,
    line,
    column,
  };
}

/**
 * Every project needs a unique non-empty name. Playwright accepts unnamed projects, but the
 * harness keys its dependency map, its serial groups and its `--test-list` selections by name, and
 * unnamed projects would overwrite each other in all three.
 */
function assertNamedProjects(projects) {
  const seen = new Set();
  projects.forEach((project, position) => {
    if (!project.name) {
      throw new Error(
        `project #${position + 1} has no name: every project needs a unique non-empty name ` +
          'for the harness'
      );
    }
    if (seen.has(project.name)) {
      throw new Error(`project name "${project.name}" is used twice: names must be unique`);
    }
    seen.add(project.name);
  });
}

/** Distinct project names that appear in a list of leaves. */
function projectsOf(leaves) {
  return [...new Set(leaves.map((leaf) => leaf.project))];
}

/**
 * For each project of the config, every project a run of it needs: its dependencies and their
 * teardowns, transitively. `projects` is `[{ name, dependencies, teardown }]` from the reporter.
 * The map has no prototype, because project names are user strings and `__proto__` is one.
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
  const map = Object.create(null);
  for (const project of projects) map[project.name] = [...closure(project.name)];
  return map;
}

/** Projects that some other project depends on (setup and teardown). */
function dependencyProjects(dependencies) {
  return new Set(Object.values(dependencies).flat());
}

/**
 * Returns leaves with `dependency` set. This is the one classification rule. `topLevel` holds the
 * projects whose own tests the selection keeps, as Playwright reports them: it applies
 * `--repeat-each` to those projects only and runs every other listed project unchanged, as a
 * dependency of a top-level one. A leaf is a dependency, exempt from exactly-once coverage, when its project is
 * not top-level. Every other leaf is primary, which includes a setup or teardown project the
 * filters or `--project` left standing on its own, and every project under `--no-deps`.
 */
function classify(leaves, topLevel) {
  return leaves.map((leaf) => ({ ...leaf, dependency: !topLevel.has(leaf.project) }));
}

/** A leaf as a listing knows it: the reporter's run fields (outcome, attempts, duration) dropped. */
function listedLeaf(leaf) {
  const fields = ['key', 'label', 'testRef', 'file', 'specFile', 'project', 'titlePath'];
  const listed = Object.fromEntries(fields.map((field) => [field, leaf[field]]));
  const { repeatIndex, serialGroup, line, column } = leaf;
  return { ...listed, repeatIndex, serialGroup, dependency: false, line, column };
}

/** The `--list` text form of a leaf, the line format `--test-list` accepts. */
function listLine(leaf) {
  return `[${leaf.project}]${TITLE_SEPARATOR}${leaf.file}:${leaf.line}:${leaf.column}${TITLE_SEPARATOR}${leaf.titlePath.join(TITLE_SEPARATOR)}`;
}

/**
 * A `--test-list` line that loads the spec file of a leaf and selects no test: its title path is
 * one no test has. Needed when the leaf's call location is a helper, which Playwright does not
 * load as a test file.
 */
function loadLine(leaf) {
  return `[${leaf.project}]${TITLE_SEPARATOR}${leaf.specFile}:1:1${TITLE_SEPARATOR}${LOAD_ONLY_TITLE}`;
}

module.exports = {
  TITLE_SEPARATOR,
  assertNamedProjects,
  buildLeaf,
  classify,
  dependencyMap,
  dependencyProjects,
  groupBase,
  leafLabel,
  listLine,
  listedLeaf,
  loadLine,
  projectsOf,
  serialGroupId,
  toPosix,
};
