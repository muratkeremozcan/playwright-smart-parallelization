'use strict';

/**
 * Units and the setup projects they need. A unit is one spec file of one project at one repeat,
 * the group Playwright itself keeps on one shard when a file is not in parallel mode. Whole files
 * keep every serial describe whole without reading any private field of Playwright's suites.
 *
 * `dependencyProjects` and `setupPhases` are ported from playwright-shard-balancer@0.1.2
 * (`src/report.ts` at commit 4c8f847c94324064e06e30815c1cb1a9369c63f8,
 * https://github.com/qa-gary-parker/playwright-shard-balancer). That code is under this notice:
 *
 * MIT License
 *
 * Copyright (c) 2026 Gary Parker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/**
 * Projects that run only as a setup or teardown dependency of the given projects, the way
 * Playwright's buildProjectsClosure marks them. Playwright never shards them. `projects` are
 * `{ name, dependencies, teardown }`.
 */
function dependencyProjects(projects, names) {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const deps = new Set();
  const visit = (name, depth) => {
    if (depth > 0) {
      if (deps.has(name)) return;
      deps.add(name);
    }
    const project = byName.get(name);
    for (const dep of (project && project.dependencies) || []) visit(dep, depth + 1);
    if (project && project.teardown) visit(project.teardown, depth + 1);
  };
  for (const name of new Set(names)) visit(name, 0);
  return deps;
}

/**
 * The phase Playwright runs each setup and teardown project in (createPhasesTask). A project waits
 * for its dependencies, and a teardown also waits for every project that needs its setup. The
 * projects of one phase run side by side on the workers.
 */
function setupPhases(projects, names) {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const setups = dependencyProjects(projects, names);
  const running = new Set([...names, ...setups]);
  const needs = (name, setup) => dependencyProjects(projects, [name]).has(setup);
  const waitsFor = new Map(
    [...running].map((name) => [
      name,
      ((byName.get(name) && byName.get(name).dependencies) || []).filter((d) => running.has(d)),
    ])
  );
  for (const setup of running) {
    const teardown = byName.get(setup) && byName.get(setup).teardown;
    if (teardown && running.has(teardown)) {
      waitsFor
        .get(teardown)
        .push(setup, ...[...running].filter((p) => p !== teardown && needs(p, setup)));
    }
  }
  const phases = new Map();
  const phaseOf = (name, path = new Set()) => {
    if (phases.has(name)) return phases.get(name);
    if (path.has(name)) return 0;
    path.add(name);
    const phase = Math.max(-1, ...(waitsFor.get(name) || []).map((d) => phaseOf(d, path))) + 1;
    path.delete(name);
    phases.set(name, phase);
    return phase;
  };
  return new Map([...setups].map((name) => [name, phaseOf(name)]));
}

/** The id of the unit of a test: its project, spec file and repeat. */
const unitId = (project, file, repeat) => JSON.stringify([project, file, repeat]);

/**
 * Units from tests `{ key, project, file, repeat, staticSkip }`, in the order given, priced by
 * `estimator`. `depsOf(project)` names the setup projects a project needs. Returns the units in
 * first-seen order and a map from unit id to the indexes of its tests.
 */
function buildUnits(tests, estimator, depsOf) {
  const units = new Map();
  const members = new Map();
  tests.forEach((test, index) => {
    const id = unitId(test.project, test.file, test.repeat);
    let unit = units.get(id);
    if (!unit) {
      unit = {
        id,
        project: test.project,
        file: test.file,
        keys: [],
        cost: 0,
        order: units.size,
        active: 0,
        unknown: 0,
        deps: depsOf(test.project),
      };
      units.set(id, unit);
      members.set(id, []);
    }
    unit.keys.push(test.key);
    unit.cost += estimator.estimate(test);
    if (!test.staticSkip) unit.active++;
    if (!test.staticSkip && !estimator.isKnown(test.key)) unit.unknown++;
    members.get(id).push(index);
  });
  return { units: [...units.values()], members };
}

/** The cost of each setup project: the sum of the estimates of its tests. */
function setupCosts(setupTests, estimator) {
  const costs = new Map();
  for (const test of setupTests) {
    costs.set(test.project, (costs.get(test.project) || 0) + estimator.estimate(test));
  }
  return costs;
}

module.exports = { buildUnits, dependencyProjects, setupCosts, setupPhases, unitId };
