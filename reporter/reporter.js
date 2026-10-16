'use strict';

/**
 * The preprocess reporter the Action adds to every shard with `--add-reporter`. The user's config
 * stays untouched; Playwright loads it itself. The reporter reads its options from the `PSP_*`
 * environment the run phase sets, and uses only the public reporter API: `Reporter.preprocess`,
 * `TestRun.exclude` and `TestRun.skipSharding`. It reads no private field of Playwright and makes
 * no network call.
 *
 * Balanced mode: `preprocess` reads the snapshot the prepare job pinned, checks its sha, prices
 * every unit (one spec file of one project at one repeat), plans the run, excludes the units of
 * the other shards, turns Playwright's own split off and logs one plan line. Any problem with the
 * snapshot throws, so the shard fails before any test runs. Native mode leaves the split to
 * Playwright and only records. In both modes `onEnd` writes the run record the finish phase checks.
 *
 *   PSP_MODE           balanced | native
 *   PSP_SHARD          this shard, PSP_TOTAL the shard count
 *   PSP_SNAPSHOT       the snapshot file (balanced), PSP_SNAPSHOT_SHA its sha
 *   PSP_KEY            the history key, PSP_WORKERS the workers the plan packs for
 *   PSP_RECORD         where onEnd writes the record
 *   PSP_RUN_ID, PSP_RUN_ATTEMPT, PSP_COMMIT, PSP_RUNNER_NAME, PSP_REASON   identity of the run
 */

const fs = require('node:fs');
const path = require('node:path');
const { balance } = require('../lib/plan/balance');
const { createEstimator, testKey } = require('../lib/plan/estimate');
const { buildUnits, dependencyProjects, setupCosts, setupPhases } = require('../lib/plan/units');
const { parseHistory } = require('../lib/history');
const { RECORD_SCHEMA, RECORD_VERSION } = require('../lib/check');
const { fingerprint } = require('../lib/identity');
const { formatMs, sha256, short, writeAtomic } = require('../lib/util');

const PREFIX = '[playwright-smart-parallelization]';
const log = (message) => process.stdout.write(`${PREFIX} ${message}\n`);

function optionsFromEnv(env = process.env) {
  const mode = env.PSP_MODE;
  if (mode !== 'balanced' && mode !== 'native') {
    throw new Error(
      `${PREFIX} PSP_MODE must be balanced or native, got ${JSON.stringify(mode)}: ` +
        'this reporter is added by the Action and reads its options from the environment'
    );
  }
  const int = (name, fallback) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${PREFIX} ${name} must be a positive integer, got ${env[name]}`);
    }
    return value;
  };
  return {
    mode,
    shard: int('PSP_SHARD'),
    total: int('PSP_TOTAL'),
    workers: int('PSP_WORKERS', 1),
    snapshot: env.PSP_SNAPSHOT || null,
    snapshotSha: env.PSP_SNAPSHOT_SHA || null,
    key: env.PSP_KEY || '',
    record: env.PSP_RECORD || null,
    runId: int('PSP_RUN_ID', 1),
    attempt: int('PSP_RUN_ATTEMPT', 1),
    commit: env.PSP_COMMIT || '',
    runner: env.PSP_RUNNER_NAME || '',
    reason: env.PSP_REASON || null,
  };
}

const toPosix = (p) => p.split(path.sep).join('/');

function fileSuiteOf(test) {
  let suite = test.parent;
  while (suite && suite.type !== 'file') suite = suite.parent;
  return suite;
}

const projectsOf = (config) =>
  config.projects.map((p) => ({
    name: p.name,
    dependencies: p.dependencies || [],
    teardown: p.teardown || null,
  }));

/**
 * Unnamed or duplicate project names have no stable identity in the history or the plan, so they
 * are refused before any test runs.
 */
function assertNamedProjects(projects) {
  const seen = new Set();
  projects.forEach((project, index) => {
    if (!project.name) {
      throw new Error(
        `${PREFIX} project ${index + 1} of the config has no name; every project needs a unique ` +
          'name, which keys its tests in the timing history'
      );
    }
    if (seen.has(project.name)) {
      throw new Error(`${PREFIX} two projects are named ${JSON.stringify(project.name)}`);
    }
    seen.add(project.name);
  });
}

/** The identity of a test: `{ id, key, project, file, repeat, label, staticSkip }`. */
function describeTest(test, rootDir) {
  const project = test.parent.project().name;
  const fileSuite = fileSuiteOf(test);
  const file = toPosix(
    path.relative(
      rootDir,
      (fileSuite && fileSuite.location && fileSuite.location.file) || test.location.file
    )
  );
  const titles = test.titlePath().slice(3);
  const repeat = test.repeatEachIndex;
  return {
    id: test.id,
    key: testKey(project, file, titles),
    project,
    file,
    repeat,
    label: `${project} › ${file} › ${titles.join(' › ')}${repeat ? ` #${repeat}` : ''}`,
    staticSkip: test.expectedStatus === 'skipped',
  };
}

function readSnapshot(options) {
  if (!options.snapshot || !options.snapshotSha) {
    throw new Error('balanced mode needs PSP_SNAPSHOT and PSP_SNAPSHOT_SHA');
  }
  let text;
  try {
    text = fs.readFileSync(options.snapshot, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the snapshot ${options.snapshot}: ${error.message}`, {
      cause: error,
    });
  }
  const sha = sha256(text);
  if (sha !== options.snapshotSha) {
    throw new Error(
      `the snapshot has sha ${short(sha)}, the prepare job pinned ${short(options.snapshotSha)}`
    );
  }
  const history = parseHistory(text, { key: options.key, source: 'the snapshot' });
  if (Object.keys(history.tests).length === 0) throw new Error('the snapshot has no entries');
  return { history, sha };
}

class SmartParallelizationReporter {
  constructor(options = {}) {
    this.options = { ...optionsFromEnv(), ...options };
    this.preprocessed = false;
    this.config = null;
    this.tests = [];
    this.setupProjects = new Set();
    this.firstStart = Infinity;
    this.lastEnd = -Infinity;
    this.record = {
      schema: RECORD_SCHEMA,
      version: RECORD_VERSION,
      run: { id: this.options.runId, attempt: this.options.attempt },
      commit: this.options.commit,
      runner: this.options.runner,
      shard: { current: this.options.shard, total: this.options.total },
      mode: this.options.mode,
      reason: this.options.reason,
      key: this.options.key,
      fingerprint: null,
      playwright: null,
      workers: this.options.workers,
      planSha: null,
      snapshotSha: null,
      predictedMs: null,
      projects: null,
      phases: null,
      corpus: null,
    };
  }

  printsToStdio() {
    return false;
  }

  async preprocess({ config, suite, testRun }) {
    const { options } = this;
    const label = `shard ${options.shard}/${options.total}`;
    this.config = config;
    this.record.playwright = config.version;
    this.record.fingerprint = fingerprint(options.key, config.version);
    if (
      !config.shard ||
      config.shard.current !== options.shard ||
      config.shard.total !== options.total
    ) {
      throw new Error(
        `${PREFIX} ${label}: Playwright runs ${config.shard ? `shard ${config.shard.current}/${config.shard.total}` : 'unsharded'}, ` +
          'which is not the shard the Action started'
      );
    }
    const projects = projectsOf(config);
    assertNamedProjects(projects);
    const names = suite.suites.map((s) => s.title);
    const readonly = dependencyProjects(projects, names);
    this.setupProjects = readonly;
    const phases = setupPhases(projects, names);
    this.record.projects = Object.fromEntries(
      projects
        .filter((p) => names.includes(p.name) && !readonly.has(p.name))
        .map((p) => [p.name, [...dependencyProjects(projects, [p.name])].sort()])
    );
    this.record.phases = Object.fromEntries([...phases].sort());

    const tests = [];
    const setupTests = [];
    const testsOf = new Map();
    for (const projectSuite of suite.suites) {
      for (const test of projectSuite.allTests()) {
        const entry = describeTest(test, config.rootDir);
        if (readonly.has(entry.project)) setupTests.push(entry);
        else {
          testsOf.set(test, tests.length);
          tests.push(entry);
        }
      }
    }
    this.record.corpus = tests.map((t) => [t.id, t.label]);
    this.preprocessed = true;

    if (options.mode === 'native') {
      log(
        `${label}: native sharding${options.reason ? ` (${options.reason})` : ''}, ${tests.length} tests in the selection`
      );
      return;
    }

    let snapshot;
    try {
      snapshot = readSnapshot(options);
    } catch (error) {
      throw new Error(
        `${PREFIX} ${label}: ${error.message}; balanced mode is strict, so this shard stops ` +
          'before any test rather than split the suite differently from the other shards',
        { cause: error }
      );
    }
    const estimator = createEstimator(snapshot.history.tests);
    const projectDeps = new Map(Object.entries(this.record.projects));
    const { units, members } = buildUnits(
      tests,
      estimator,
      (project) => projectDeps.get(project) || []
    );
    const plan = balance(
      units,
      options.total,
      options.workers,
      setupCosts(setupTests, estimator),
      phases
    );
    const mine = plan.shards[options.shard - 1];
    const keep = new Set();
    for (const unit of mine.units) for (const index of members.get(unit.id)) keep.add(index);
    for (const projectSuite of suite.suites) {
      if (readonly.has(projectSuite.title)) continue;
      for (const fileSuite of [...projectSuite.suites]) {
        const inFile = fileSuite.allTests();
        if (inFile.every((test) => !keep.has(testsOf.get(test)))) testRun.exclude(fileSuite);
        else for (const test of inFile) if (!keep.has(testsOf.get(test))) testRun.exclude(test);
      }
    }
    testRun.skipSharding();
    this.record.planSha = plan.sha;
    this.record.snapshotSha = snapshot.sha;
    this.record.predictedMs = plan.shards.map((s) => s.wallMs);
    const walls = plan.shards.map((s) => s.wallMs);
    const known = tests.length - plan.unknownTests;
    log(
      `${label}: balanced, ${mine.files} files, ${mine.tests} tests, ~${formatMs(mine.wallMs)} ` +
        `(all shards ${formatMs(Math.min(...walls))}-${formatMs(Math.max(...walls))}), ` +
        `${known}/${tests.length} tests known, ${options.workers} worker(s), ` +
        `snapshot ${short(snapshot.sha)}, plan ${short(plan.sha)}`
    );
  }

  onBegin(config, suite) {
    this.config = this.config || config;
    this.record.playwright = this.record.playwright || config.version;
    this.record.fingerprint =
      this.record.fingerprint || fingerprint(this.options.key, config.version);
    if (!this.preprocessed) {
      // Playwright without the preprocess hook split the suite itself; the record says so with no
      // corpus, and the finish phase refuses it.
      log(`Playwright ${config.version} did not call preprocess, so this shard was not planned`);
    }
    this.tests = suite.allTests();
  }

  onTestEnd(_test, result) {
    const start = result.startTime.getTime();
    this.firstStart = Math.min(this.firstStart, start);
    this.lastEnd = Math.max(this.lastEnd, start + result.duration);
  }

  async onEnd(result) {
    if (!this.options.record || !this.config) return;
    const rootDir = this.config.rootDir;
    const tests = this.tests.map((test) => {
      const entry = describeTest(test, rootDir);
      const outcome = test.outcome();
      // The sample is the attempt that ended as expected: a slow failed attempt before a passing
      // retry adds nothing to it. A statically skipped test has nothing to run.
      let sampleMs = null;
      if (!entry.staticSkip && (outcome === 'expected' || outcome === 'flaky')) {
        const good = test.results.filter((r) => r.status === test.expectedStatus).pop();
        if (good && good.duration > 0) sampleMs = Math.round(good.duration);
      }
      const ran =
        entry.staticSkip ||
        (test.results.length > 0 && test.results.every((r) => r.status !== 'interrupted'));
      return {
        id: entry.id,
        key: entry.key,
        repeat: entry.repeat,
        setup: this.setupProjects.has(entry.project),
        outcome,
        ran,
        sample_ms: sampleMs,
      };
    });
    const record = {
      ...this.record,
      status: result.status,
      wallMs: Math.round(result.duration),
      testsMs: this.lastEnd > this.firstStart ? Math.round(this.lastEnd - this.firstStart) : 0,
      tests,
    };
    writeAtomic(path.resolve(this.options.record), `${JSON.stringify(record)}\n`);
  }
}

module.exports = SmartParallelizationReporter;
module.exports.assertNamedProjects = assertNamedProjects;
module.exports.optionsFromEnv = optionsFromEnv;
