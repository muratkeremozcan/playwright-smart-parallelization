'use strict';

/**
 * Leaf model. A leaf is one test in one project at one repeat: the unit a partition must cover
 * exactly once. Both the list JSON of `playwright test --list` and the harness reporter produce
 * leaves through the helpers here, so a key built from a list and a key built from a run match.
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

/**
 * Parses the JSON of `playwright test --list --reporter=json` into leaves. The JSON carries no
 * repeat index, so the index is the occurrence order of a test within its project.
 */
function parseList(json) {
  const testDirs = {};
  for (const project of (json.config && json.config.projects) || []) {
    testDirs[project.name] = project.testDir;
  }
  const seen = new Map();
  const leaves = [];

  function visit(suite, describes, file) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const project = test.projectName;
        const titlePath = [...describes, spec.title];
        const specFile = toPosix(spec.file || file);
        const identity = `${project}|${specFile}|${spec.line}:${spec.column}|${titlePath.join('\u0000')}`;
        const repeatIndex = seen.get(identity) || 0;
        seen.set(identity, repeatIndex + 1);
        leaves.push(
          buildLeaf({
            project,
            file: specFile,
            titlePath,
            repeatIndex,
            annotations: test.annotations,
            testDir: testDirs[project],
            line: spec.line,
            column: spec.column,
          })
        );
      }
    }
    for (const child of suite.suites || []) visit(child, [...describes, child.title], file);
  }

  for (const fileSuite of json.suites || []) {
    visit(fileSuite, [], toPosix(fileSuite.file || fileSuite.title));
  }
  return leaves;
}

/** Project names declared by the list JSON config, in declaration order. */
function projectNames(json) {
  return ((json.config && json.config.projects) || []).map((project) => project.name);
}

/** Distinct project names that appear in a list of leaves. */
function projectsOf(leaves) {
  return [...new Set(leaves.map((leaf) => leaf.project))];
}

/**
 * `listsByProject` maps a project to the leaves listed for `--project=P`. Playwright adds the
 * dependency and teardown projects of P to that listing, so the projects listed minus P are the
 * dependencies of P.
 */
function deriveDependencies(listsByProject) {
  const dependencies = {};
  for (const [project, leaves] of Object.entries(listsByProject)) {
    dependencies[project] = projectsOf(leaves).filter((name) => name !== project);
  }
  return dependencies;
}

/** Projects that some other project depends on (setup and teardown). */
function dependencyProjects(dependencies) {
  return new Set(Object.values(dependencies).flat());
}

/** Returns leaves with `dependency` set from the dependency map. */
function applyDependencies(leaves, dependencies) {
  const projects = dependencyProjects(dependencies);
  return leaves.map((leaf) => ({ ...leaf, dependency: projects.has(leaf.project) }));
}

/** The `--list` text form of a leaf, the line format `--test-list` accepts. */
function listLine(leaf) {
  return `[${leaf.project}]${TITLE_SEPARATOR}${leaf.file}:${leaf.line}:${leaf.column}${TITLE_SEPARATOR}${leaf.titlePath.join(TITLE_SEPARATOR)}`;
}

module.exports = {
  TITLE_SEPARATOR,
  applyDependencies,
  buildLeaf,
  dependencyProjects,
  deriveDependencies,
  groupBase,
  leafKey,
  listLine,
  parseList,
  projectNames,
  projectsOf,
  serialGroupId,
  testId,
  toPosix,
};
