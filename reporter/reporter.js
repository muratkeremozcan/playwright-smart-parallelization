'use strict';

/**
 * The preprocess reporter that `$PSP_ARGS` adds to the user's command with `--add-reporter`. The
 * user's config stays untouched; Playwright loads it itself. The reporter reads its options from
 * the `PSP_*` environment the Action's main step exports, takes the shard from Playwright's own
 * resolved `config.shard`, and uses only the public reporter API: `Reporter.preprocess`,
 * `TestRun.exclude` and `TestRun.skipSharding`. It reads no private field of Playwright and makes
 * no network call.
 *
 * Balanced mode: `preprocess` reads the pinned snapshot, checks its sha, prices every unit (one
 * spec file of one project at one repeat), plans the run for the worker count the snapshot
 * carries, excludes the units of the other shards, turns Playwright's own split off and logs one
 * plan line. Every shard reads one snapshot, so every shard packs for one count; a shard whose
 * Playwright resolved another count, such as a percentage on a runner with other CPUs, says so in
 * one line and keeps the plan, so the split stays exactly once. Playwright runs it with its own
 * count. Any problem with the snapshot throws, so the shard fails before any test runs. Native mode, and any run without `--shard`, leaves the
 * split to Playwright and only records. In every mode `onEnd` writes the run record that the
 * Action's post step publishes from and the finish action checks.
 *
 *   PSP_MODE           balanced | native
 *   PSP_SNAPSHOT       the snapshot file (balanced), PSP_SNAPSHOT_SHA its sha
 *   PSP_KEY            the history key
 *   PSP_RECORD         where onEnd writes the record
 *   PSP_PINNED         whether the mode came from a pinned snapshot
 *   PSP_START          the token of the start marker the main step uploaded
 *   PSP_JOB, PSP_HISTORY_KEY, PSP_RUN_ID, PSP_RUN_ATTEMPT, PSP_COMMIT, PSP_RUNNER_NAME,
 *   PSP_REASON         identity of the run
 */

const fs = require('node:fs');
const path = require('node:path');
const { balance } = require('../lib/plan/balance');
const { createEstimator, testKey } = require('../lib/plan/estimate');
const { buildUnits, dependencyProjects, setupCosts, setupPhases } = require('../lib/plan/units');
const { parseHistory } = require('../lib/history');
const { RECORD_SCHEMA, RECORD_VERSION, corpusSha } = require('../lib/check');
const { fingerprint } = require('../lib/identity');
const { parseInvocation } = require('../lib/invocation');
const { formatMs, sha256, short, writeAtomic } = require('../lib/util');

const PREFIX = '[playwright-smart-parallelization]';
const log = (message) => process.stdout.write(`${PREFIX} ${message}\n`);

function optionsFromEnv(env = process.env) {
  const mode = env.PSP_MODE;
  if (mode !== 'balanced' && mode !== 'native') {
    throw new Error(
      `${PREFIX} PSP_MODE must be balanced or native, got ${JSON.stringify(mode)}: ` +
        'this reporter is added by $PSP_ARGS and reads its options from the environment the Action exports'
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
    snapshot: env.PSP_SNAPSHOT || null,
    snapshotSha: env.PSP_SNAPSHOT_SHA || null,
    key: env.PSP_KEY || '',
    record: env.PSP_RECORD || null,
    runId: int('PSP_RUN_ID', 1),
    attempt: int('PSP_RUN_ATTEMPT', 1),
    commit: env.PSP_COMMIT || '',
    runner: env.PSP_RUNNER_NAME || '',
    reason: env.PSP_REASON || null,
    job: env.PSP_JOB || '',
    pinned: env.PSP_PINNED === 'true',
    historyKey: env.PSP_HISTORY_KEY || '',
    start: env.PSP_START || null,
  };
}

const toPosix = (p) => p.split(path.sep).join('/');

function fileSuiteOf(test) {
  let suite = test.parent;
  while (suite && suite.type !== 'file') suite = suite.parent;
  return suite;
}

/** The projects of the config with the edges this run keeps: none under `--no-deps`. */
const projectsOf = (config, { noDeps }) =>
  config.projects.map((p) => ({
    name: p.name,
    dependencies: noDeps ? [] : p.dependencies || [],
    teardown: noDeps ? null : p.teardown || null,
  }));

/**
 * A project's name keys its tests in the history and the plan. One unnamed project, such as the
 * implicit project of a config without `projects`, has the stable identity `''`. Two projects with
 * one name, unnamed ones included, have none, so they are refused before any test runs.
 */
function assertNamedProjects(projects) {
  const byName = new Map();
  projects.forEach((project, index) => {
    const name = project.name || '';
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(index + 1);
  });
  for (const [name, indexes] of byName) {
    if (indexes.length < 2) continue;
    throw new Error(
      name
        ? `${PREFIX} projects ${indexes.join(' and ')} of the config are both named ${JSON.stringify(name)}; every project needs a unique name, which keys its tests in the timing history`
        : `${PREFIX} projects ${indexes.join(' and ')} of the config have no name; give them unique names, which key their tests in the timing history`
    );
  }
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
      `the snapshot has sha ${short(sha)}, the pin holds ${short(options.snapshotSha)}`
    );
  }
  const history = parseHistory(text, { key: options.key, source: 'the snapshot' });
  if (Object.keys(history.tests).length === 0) throw new Error('the snapshot has no entries');
  if (!history.source) throw new Error('the snapshot names no run, so no worker count to plan for');
  return { history, sha };
}

class SmartParallelizationReporter {
  constructor(options = {}) {
    this.options = { argv: process.argv, ...optionsFromEnv(), ...options };
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
      job: this.options.job,
      start: this.options.start,
      pinned: this.options.pinned,
      historyKey: this.options.historyKey,
      shard: { current: 1, total: 1 },
      mode: this.options.mode,
      reason: this.options.reason,
      key: this.options.key,
      fingerprint: null,
      playwright: null,
      workers: null,
      planSha: null,
      snapshotSha: null,
      predictedMs: null,
      projects: null,
      phases: null,
      corpus: null,
      corpusSha: null,
    };
  }

  printsToStdio() {
    return false;
  }

  async preprocess({ config, suite, testRun }) {
    const { options } = this;
    const shard = config.shard
      ? { current: config.shard.current, total: config.shard.total }
      : { current: 1, total: 1 };
    const label = `shard ${shard.current}/${shard.total}`;
    this.config = config;
    this.record.shard = shard;
    this.record.playwright = config.version;
    this.record.fingerprint = fingerprint(options.key, config.version);
    this.record.workers = config.workers;
    let invocation;
    try {
      invocation = parseInvocation(options.argv);
    } catch (error) {
      throw new Error(`${PREFIX} ${label}: ${error.message}`, { cause: error });
    }
    if (invocation.lastFailed) {
      throw new Error(
        `${PREFIX} ${label}: --last-failed is not supported. Playwright applies it after the ` +
          "split, so no shard can prove which tests the run selected; skip the Action's step for " +
          'that command with an if: condition, which leaves $PSP_ARGS empty and the run plain Playwright'
      );
    }
    const projects = projectsOf(config, invocation);
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
    this.record.corpusSha = corpusSha(this.record.corpus);
    this.preprocessed = true;

    if (!config.shard) {
      this.record.mode = 'native';
      this.record.reason = 'the command has no --shard';
      log(`no --shard in the command, so this run is not balanced; ${tests.length} tests recorded`);
      return;
    }
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
          'before any test and every shard keeps one plan',
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
    const workers = snapshot.history.source.workers;
    if (workers !== config.workers) {
      log(
        `${label}: Playwright resolved ${config.workers} worker(s), the pinned snapshot ` +
          `${workers}; every shard plans for ${workers}, so the split stays exactly once`
      );
    }
    const plan = balance(units, shard.total, workers, setupCosts(setupTests, estimator), phases);
    const mine = plan.shards[shard.current - 1];
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
        `${known}/${tests.length} tests known, planned for ${workers} worker(s), ` +
        `snapshot ${short(snapshot.sha)}, plan ${short(plan.sha)}`
    );
  }

  onBegin(config, suite) {
    this.config = this.config || config;
    this.record.workers = this.record.workers || config.workers;
    this.record.playwright = this.record.playwright || config.version;
    this.record.fingerprint =
      this.record.fingerprint || fingerprint(this.options.key, config.version);
    if (!this.preprocessed) {
      if (config.shard) {
        this.record.shard = { current: config.shard.current, total: config.shard.total };
      }
      // Playwright without the preprocess hook split the suite itself; the record says so with no
      // corpus, and the finish action refuses it.
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
      startedAt: result.startTime ? new Date(result.startTime).toISOString() : null,
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
