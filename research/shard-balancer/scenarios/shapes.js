'use strict';

/**
 * The two shapes the Action can take when users install no package and add no reporter (rows
 * `sa.*` and `sb.*`).
 *
 * Shape A plans inside the Action: `plan` writes one `--test-list` file per shard from the JSON
 * list and the timings, and the shards run Playwright with their file and no `--shard`. Where
 * `plan` refuses a suite, the harness's own `testListPartition` writes the files from the same
 * assignment.
 *
 * Shape B injects the reporter without touching the user's config: a wrapper config the Action
 * generates in a folder of its own loads the user's config and appends the reporter
 * (`lib/wrapper.js`), or the Action passes the reporter with `--add-reporter`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertSelectable, testListPartition } = require('../../../harness/partitions');
const { scrub } = require('../../../qualification/flakiness/playwright');
const { prefixProject } = require('../../../qualification/lib/variants');
const drive = require('../drive');
const { writeWrapper } = require('../lib/wrapper');
const { cli, reporterPath } = require('../upstream');
const { checkRun, strategies } = require('./assignment');
const { damagedTimings } = require('./safety');
const { harnessFacts, kindsText, row } = require('./row');

const HARNESS_REPORTER = path.resolve(__dirname, '..', '..', '..', 'harness', 'reporter.js');
const CONFIG_PROBE = path.resolve(__dirname, '..', 'lib', 'config-probe.js');
const OUTPUT_KEYS = ['outputFile', 'outputFolder', 'outputDir'];
const sha12 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex').slice(0, 12);
const firstLine = (text) =>
  scrub(
    (text || '')
      .split('\n')
      .map((l) => l.replace(/^playwright-shard-balancer: /, '').trim())
      .find(Boolean) || ''
  );

// ---------------------------------------------------------------------------------------------
// Shape A

const HELPER = `'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

module.exports = (name) => {
  test(\`\${name} from the helper\`, async () => {
    await sleep(60);
  });
};
`;

/** The fixture plus a spec whose tests a helper file registers. */
function helperProject(ctx) {
  return ctx.once('variant:helper', () =>
    ctx.copy('variant-helper', {
      'tests/helper.js': HELPER,
      'tests/helped.spec.js': "'use strict';\n\nrequire('./helper')('helped');\n",
    })
  );
}

/** The JSON `--list` report of a project, the input of `plan`. */
function listOf(ctx, cwd, name, forward = []) {
  return ctx.once(`list:${name}`, () =>
    drive.listReport({
      cwd,
      config: ctx.config(cwd),
      file: path.join(ctx.dir(`list-${name}`), 'list.json'),
      forward,
    })
  );
}

/** `plan` into a fresh folder: exit code, first error line, the list files and `plan.json`. */
function plan(ctx, name, { list, timings, shards = 3 }) {
  return ctx.once(`plan:${name}`, () => {
    const outDir = ctx.dir(`plan-${name}`);
    const call = cli([
      'plan',
      ...['--timings', timings, '--list', list, '--shards', String(shards), '--workers', '1'],
      ...['--out-dir', outDir],
    ]);
    const files = Array.from({ length: shards }, (_, i) =>
      path.join(outDir, `shard-${i + 1}.txt`)
    ).filter((file) => fs.existsSync(file));
    const planFile = path.join(outDir, 'plan.json');
    return {
      status: call.status,
      message: firstLine(call.stderr),
      files,
      plan: fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null,
    };
  });
}

/**
 * The shards of a run of list files: `--test-list FILE` and no `--shard`. Each shard writes its
 * record to a path of its own, since a record of a run without `--shard` is named `all`, and its
 * Playwright JSON report.
 */
function listPartition(dir, files) {
  return files.map((file, position) => {
    const index = position + 1;
    const env = drive.shardEnv({ dir, index, json: true });
    env.PSP_PSB_RECORD = path.join(dir, 'records', `run-${index}-{shard}.json`);
    return { args: ['--test-list', file], env };
  });
}

/** The plan of the fixture in three list files, run through the harness. */
function planRun(ctx) {
  return ctx.once('sa:plan-run', () => {
    const list = listOf(ctx, ctx.cwd, 'fixture');
    const planned = plan(ctx, 'fixture', { list, timings: ctx.baseline().timings });
    if (planned.status !== 0) throw new Error(`plan failed: ${planned.message}`);
    const name = 'plan-lists-3';
    const run = ctx.runPartition({
      name,
      partition: listPartition(ctx.dir(name), planned.files),
      workers: 1,
    });
    return { list, planned, run };
  });
}

function planRunRow(ctx) {
  const { planned, run } = planRun(ctx);
  const facts = {
    ...harnessFacts(run),
    serialSplit: run.summary.kinds['serial-split'] || 0,
    files: planned.files.length,
    lines: planned.files.map((f) => fs.readFileSync(f, 'utf8').trim().split('\n').length),
    planSha: planned.plan.sha,
    hasShardArg: run.partition.some((s) => s.args.some((a) => a.startsWith('--shard'))),
    recordShards: run.records.map((r) => (r ? r.data.shard : 'none')),
  };
  return row(
    'sa.plan-run',
    'Per-shard `--test-list` files written by `plan` run every leaf once, keep serial groups whole and run setup once in each shard that needs it, with no `--shard`.',
    facts.harnessOk && !facts.hasShardArg,
    facts,
    `\`plan\` wrote ${facts.files} list files (${facts.lines.join(' / ')} lines, plan \`${facts.planSha}\`). Run through the harness with \`--test-list\` and no \`--shard\`: violations ${kindsText(facts.violations)}, ${facts.serialSplit} serial groups split, and every record has no shard number.`
  );
}

function checkList(ctx) {
  const { list, run } = planRun(ctx);
  const files = run.records.filter(Boolean).map((r) => r.file);
  const without = drive.check(files);
  const withList = drive.check(files, { list });
  const facts = {
    withoutListExit: without.status,
    withoutListNamesShards: (without.json ? without.json.problems : []).some((p) =>
      p.startsWith('the records have no shard numbers')
    ),
    withListExit: withList.status,
    withListTests: withList.json ? withList.json.tests : null,
  };
  return row(
    'sa.check-list',
    'Records of `--test-list` runs carry no shard number, so `check` needs the JSON list to prove the run.',
    facts.withoutListExit === 1 && facts.withoutListNamesShards && facts.withListExit === 0,
    facts,
    `Without \`--list\`, \`check\` exits ${facts.withoutListExit} and says the records have no shard numbers; with the JSON list it exits ${facts.withListExit} over ${facts.withListTests} tests.`
  );
}

/** Whether the harness selection contract accepts a listing, and its error. */
function selectable(listing) {
  try {
    assertSelectable(listing.leaves);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: scrub(error.message.split(':')[0]) };
  }
}

function refusals(ctx) {
  const timings = ctx.baseline().timings;
  const cases = {
    repeatEach: { cwd: ctx.cwd, forward: ['--repeat-each=2'], repeatEach: 2 },
    prefixTitles: { cwd: prefixProject(ctx), forward: [], repeatEach: 1 },
    helperDefined: { cwd: helperProject(ctx), forward: [], repeatEach: 1 },
  };
  const facts = {};
  for (const [name, c] of Object.entries(cases)) {
    const planned = plan(ctx, `refuse-${name}`, {
      list: listOf(ctx, c.cwd, `refuse-${name}`, c.forward),
      timings,
    });
    const harness = selectable(ctx.listing({ cwd: c.cwd, repeatEach: c.repeatEach }));
    facts[name] = {
      planExit: planned.status,
      planRefusal: planned.message.replace(/^"[^"]*"/, '"…"'),
      harnessSelectable: harness.ok,
      harnessError: harness.error,
    };
  }
  const says = (name, text) => facts[name].planExit !== 0 && facts[name].planRefusal.includes(text);
  const refused =
    says('repeatEach', 'is listed twice') &&
    says('prefixTitles', 'also starts the title of') &&
    says('helperDefined', 'is defined in helper.js');
  const contract =
    facts.repeatEach.harnessSelectable &&
    !facts.prefixTitles.harnessSelectable &&
    facts.helperDefined.harnessSelectable;
  return row(
    'sa.refusals',
    "`plan` refuses `--repeat-each` copies, a test whose title path starts another's and a test a helper defines; the harness selection contract refuses only the prefix titles.",
    refused && contract,
    facts,
    `\`plan\` exits ${Object.values(facts)
      .map((f) => f.planExit)
      .join(
        ' / '
      )} on the three suites. The harness accepts the repeats (one line selects every repeat) and the helper (a load line picks its spec), and refuses the prefix titles, as rows 1 and 4 of the selection limits note say.`
  );
}

const leafLine = (leaf) => `[${leaf.project}] › ${leaf.specFile} › ${leaf.titlePath.join(' › ')}`;

function fallbackRepeat(ctx) {
  const { planned } = planRun(ctx);
  const shardOf = new Map();
  planned.files.forEach((file, i) => {
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) shardOf.set(line, i);
  });
  const listing = ctx.listing({ repeatEach: 2 });
  const assignment = planned.files.map(() => []);
  for (const leaf of listing.leaves.filter((l) => !l.dependency)) {
    const shard = shardOf.get(leafLine(leaf));
    if (shard === undefined) throw new Error(`no list file holds ${leafLine(leaf)}`);
    assignment[shard].push(leaf.key);
  }
  const name = 'fallback-repeat-3';
  const run = ctx.runPartition({
    name,
    partition: testListPartition(assignment, listing.leaves, ctx.dir(name)),
    repeatEach: 2,
    workers: 1,
  });
  const facts = {
    ...harnessFacts(run),
    leaves: listing.leaves.filter((l) => !l.dependency).length,
  };
  return row(
    'sa.fallback-repeat',
    'Where `plan` refuses `--repeat-each`, list files the harness writes from the same plan run every copy once.',
    facts.harnessOk,
    facts,
    `The plan of the fixture applied to the ${facts.leaves} leaves of \`--repeat-each=2\` by \`testListPartition\`, one line per test: violations ${kindsText(facts.violations)}.`
  );
}

function fallbackHelper(ctx) {
  const cwd = helperProject(ctx);
  const listing = ctx.listing({ cwd });
  const specs = [
    ...new Set(listing.leaves.filter((l) => !l.dependency).map((l) => l.specFile)),
  ].sort();
  const assignment = [[], []];
  for (const leaf of listing.leaves.filter((l) => !l.dependency)) {
    assignment[specs.indexOf(leaf.specFile) % 2].push(leaf.key);
  }
  const name = 'fallback-helper-2';
  const run = ctx.runPartition({
    name,
    cwd,
    partition: testListPartition(assignment, listing.leaves, ctx.dir(name)),
    workers: 4,
  });
  const helped = run.raw.flatMap((s) =>
    (s.leaves || []).filter((l) => l.specFile === 'helped.spec.js')
  );
  const facts = { ...harnessFacts(run), helperLeavesRun: helped.length };
  return row(
    'sa.fallback-helper',
    'Where `plan` refuses tests a helper defines, list files the harness writes with load lines run them once.',
    facts.harnessOk && helped.length > 0,
    facts,
    `A spec whose tests a helper registers, split by spec file over two list files with \`testListPartition\`: the helper's tests ran ${helped.length} times, once per project, and violations ${kindsText(facts.violations)}.`
  );
}

function planDamaged(ctx) {
  const list = listOf(ctx, ctx.cwd, 'fixture');
  const damaged = plan(ctx, 'damaged', { list, timings: damagedTimings(ctx) });
  const absent = plan(ctx, 'absent', {
    list,
    timings: path.join(ctx.dir('plan-absent-timings'), 'none.json'),
  });
  const facts = {
    damagedExit: damaged.status,
    damagedFiles: damaged.files.length,
    absentExit: absent.status,
    absentFiles: absent.files.length,
    absentMessage: absent.message.replace(/ at .*$/, ''),
  };
  return row(
    'sa.plan-damaged',
    '`plan` exits non-zero and writes no list when the timings are damaged or absent, so the planning step falls back to native sharding before fan-out.',
    facts.damagedExit !== 0 &&
      facts.absentExit !== 0 &&
      facts.damagedFiles + facts.absentFiles === 0,
    facts,
    `A truncated timings file: exit ${facts.damagedExit}, ${facts.damagedFiles} files. No timings file: exit ${facts.absentExit}, ${facts.absentFiles} files, \`${facts.absentMessage}\`.`
  );
}

function reportHistory(ctx) {
  const { run } = planRun(ctx);
  const dir = ctx.dir('report-history');
  const fromRecords = path.join(dir, 'records.json');
  const fromReports = path.join(dir, 'reports.json');
  const records = drive.update(
    fromRecords,
    run.records.filter(Boolean).map((r) => r.file)
  );
  const reports = drive.update(
    fromReports,
    run.partition.map((s) => s.env.PLAYWRIGHT_JSON_OUTPUT_FILE).filter((f) => fs.existsSync(f))
  );
  const a = drive.readTimings(fromRecords).tests;
  const b = drive.readTimings(fromReports).tests;
  const counts = (t) =>
    Object.fromEntries(Object.entries(t).map(([k, e]) => [k, e.samples.length]));
  const setupKey = '[setup] › global.setup.js › prepare the environment';
  const facts = {
    exits: [records.status, reports.status],
    entriesFromRecords: Object.keys(a).length,
    entriesFromReports: Object.keys(b).length,
    sameKeysAndCounts: JSON.stringify(counts(a)) === JSON.stringify(counts(b)),
    setupSamples: b[setupKey] ? b[setupKey].samples.length : null,
  };
  return row(
    'sa.report-history',
    "`update` builds the same entries, with one sample each, from the shards' Playwright JSON reports as from run records, so a history needs no reporter.",
    facts.exits.every((c) => c === 0) && facts.sameKeysAndCounts && facts.setupSamples === 1,
    facts,
    `From the records of the list run, ${facts.entriesFromRecords} entries; from the JSON reports of the same shards, ${facts.entriesFromReports} entries with the same sample counts (${facts.sameKeysAndCounts}), and the setup test that every shard ran has ${facts.setupSamples} sample.`
  );
}

// ---------------------------------------------------------------------------------------------
// Shape B

const PATHS_CONFIG = `'use strict';

const { defineConfig } = require('@playwright/test');

// Relative paths of every kind the config folder resolves: test, output and snapshot folders, a
// global setup script, a local reporter and a reporter output file.
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './results',
  snapshotDir: './snaps',
  retries: 2,
  reporter: [['list'], ['json', { outputFile: 'reports/run.json' }], ['./noop-reporter.js']],
  globalSetup: './global-setup.js',
  projects: [
    { name: 'setup', testMatch: /global\\.setup\\.js/, teardown: 'teardown' },
    { name: 'teardown', testMatch: /global\\.teardown\\.js/ },
    { name: 'chromium', testMatch: /.*\\.spec\\.js/, dependencies: ['setup'] },
    { name: 'firefox', testDir: './tests', testMatch: /.*\\.spec\\.js/, dependencies: ['setup'] },
  ],
});
`;

const TS_CONFIG = `import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: './tests',
  retries: 2,
  reporter: 'list',
  projects: [
    { name: 'setup', testMatch: /global\\.setup\\.js/, teardown: 'teardown' },
    { name: 'teardown', testMatch: /global\\.teardown\\.js/ },
    { name: 'chromium', testMatch: /.*\\.spec\\.js/, dependencies: ['setup'] },
  ],
};

export default defineConfig(config);
`;

/** The fixture with a config full of relative paths, and a TypeScript config. */
function pathsProject(ctx) {
  return ctx.once('variant:paths', () =>
    ctx.copy('variant-paths', {
      'playwright.config.js': PATHS_CONFIG,
      'playwright.ts.config.ts': TS_CONFIG,
      'noop-reporter.js':
        "'use strict';\n\nmodule.exports = class { printsToStdio() { return false; } };\n",
      'global-setup.js': "'use strict';\n\nmodule.exports = async () => {};\n",
    })
  );
}

/** A wrapper the Action generates, in a folder outside the project. */
function wrapper(ctx, name, { userConfig, mode = 'resolved', options = {} }) {
  return ctx.once(`wrapper:${name}`, () =>
    writeWrapper({
      dir: ctx.dir(`action-${name}`),
      userConfig,
      mode,
      reporter: [reporterPath(), options],
    })
  );
}

/** The resolved `FullConfig` of a config, from the config probe, or `{ error }`. */
function probe(ctx, cwd, config, name) {
  return ctx.once(`config-probe:${name}`, () => {
    const out = path.join(ctx.dir(`config-probe-${name}`), 'config.json');
    const listed = drive.playwright({
      cwd,
      args: ['--list', `--config=${config}`, `--add-reporter=${CONFIG_PROBE}`],
      env: { PSP_CONFIG_PROBE_OUT: out },
    });
    if (!fs.existsSync(out))
      return { error: firstLine(listed.output.split('\n').find((l) => /Error/.test(l))) };
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  });
}

/** The `config` of the JSON `--list` report of a config, or `{ error }`. */
function listConfig(ctx, cwd, config, name) {
  return ctx.once(`list-config:${name}`, () => {
    const file = path.join(ctx.dir(`list-config-${name}`), 'list.json');
    try {
      return JSON.parse(fs.readFileSync(drive.listReport({ cwd, config, file }), 'utf8')).config;
    } catch (error) {
      return { error: firstLine(error.message) };
    }
  });
}

/** Paths at which two values differ, as `a.b[2].c`. */
function differences(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== b.length))
      return [at];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      differences(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k)
    );
  }
  return [at];
}

/**
 * The differences of a wrapper's resolved config from the user's, apart from the config file and
 * the appended reporter. A reporter output path is compared where it resolves: Playwright keeps the
 * option as written and the reporter resolves it against the folder of the config file.
 */
function configDifferences(plain, wrapped) {
  if (plain.error || wrapped.error)
    return { loads: !wrapped.error, error: wrapped.error || plain.error, fields: null };
  const outputs = (reporters, dir) =>
    reporters.map(([name, options]) => {
      if (!options) return [name, options];
      const resolved = { ...options };
      for (const key of OUTPUT_KEYS)
        if (typeof resolved[key] === 'string') resolved[key] = path.resolve(dir, resolved[key]);
      return [name, resolved];
    });
  const strip = (config, reporters) => ({ ...config, configFile: null, reporter: reporters });
  const userReporters = outputs(plain.reporter, path.dirname(plain.configFile));
  const kept = wrapped.reporter.slice(0, -1);
  const appended = wrapped.reporter[wrapped.reporter.length - 1];
  return {
    loads: true,
    error: null,
    fields: differences(
      strip(plain, userReporters),
      strip(wrapped, outputs(kept, path.dirname(wrapped.configFile)))
    ),
    appendedLast: Boolean(appended) && appended[0] === reporterPath(),
  };
}

/** The same comparison over the `config` of the JSON list report. */
function listDifferences(plain, wrapped) {
  if (plain.error || wrapped.error) return null;
  // The command line differs only in the config it names.
  const strip = (c) => ({
    ...c,
    configFile: null,
    reporter: null,
    argv: (c.argv || []).filter((arg) => !arg.startsWith('--config=')),
  });
  return differences(strip(plain), strip(wrapped));
}

function wrapperNaive(ctx) {
  const cwd = pathsProject(ctx);
  const js = path.join(cwd, 'playwright.config.js');
  const ts = path.join(cwd, 'playwright.ts.config.ts');
  const jsResult = configDifferences(
    probe(ctx, cwd, js, 'paths-js'),
    probe(ctx, cwd, wrapper(ctx, 'naive-js', { userConfig: js, mode: 'naive' }), 'naive-js')
  );
  const tsResult = configDifferences(
    probe(ctx, cwd, ts, 'paths-ts'),
    probe(ctx, cwd, wrapper(ctx, 'naive-ts', { userConfig: ts, mode: 'naive' }), 'naive-ts')
  );
  const facts = {
    jsLoads: jsResult.loads,
    jsError: jsResult.error,
    tsLoads: tsResult.loads,
    tsDifferences: tsResult.fields,
  };
  return row(
    'sb.wrapper-naive',
    "A wrapper that spreads the user's config and appends a reporter keeps the resolved config of the user's config.",
    facts.jsLoads && facts.tsLoads && facts.tsDifferences.length === 0,
    facts,
    `The JS config with a global setup script does not load through it (\`${facts.jsError}\`), and the TS config loads with ${facts.tsDifferences ? facts.tsDifferences.length : 0} resolved fields moved to the wrapper's folder (${(
      facts.tsDifferences || []
    )
      .slice(0, 4)
      .map((f) => `\`${f}\``)
      .join(
        ', '
      )}): Playwright resolves every relative path against the folder of the config file it loads.`
  );
}

function wrapperPaths(ctx) {
  const cwd = pathsProject(ctx);
  const results = {};
  for (const [kind, file] of [
    ['js', 'playwright.config.js'],
    ['ts', 'playwright.ts.config.ts'],
  ]) {
    const user = path.join(cwd, file);
    const wrapped = wrapper(ctx, `resolved-${kind}`, { userConfig: user });
    const full = configDifferences(
      probe(ctx, cwd, user, `paths-${kind}`),
      probe(ctx, cwd, wrapped, `resolved-${kind}`)
    );
    results[kind] = {
      loads: full.loads,
      error: full.error,
      fullConfigDifferences: full.fields,
      appendedLast: full.appendedLast,
      listConfigDifferences: listDifferences(
        listConfig(ctx, cwd, user, `paths-${kind}`),
        listConfig(ctx, cwd, wrapped, `resolved-${kind}`)
      ),
    };
  }
  const same = (r) =>
    r.loads &&
    r.appendedLast &&
    r.fullConfigDifferences.length === 0 &&
    r.listConfigDifferences &&
    r.listConfigDifferences.length === 0;
  return row(
    'sb.wrapper-paths',
    "The resolving wrapper gives the resolved config of the user's config, apart from the config file and the appended reporter, for a JS config with relative paths of every kind and for a TS config.",
    same(results.js) && same(results.ts),
    results,
    `JS config: ${results.js.fullConfigDifferences ? results.js.fullConfigDifferences.length : 'no'} differences in the resolved \`FullConfig\` and ${results.js.listConfigDifferences ? results.js.listConfigDifferences.length : 'no'} in the JSON list config; TS config through the JS wrapper: ${results.ts.fullConfigDifferences ? results.ts.fullConfigDifferences.length : 'no'} and ${results.ts.listConfigDifferences ? results.ts.listConfigDifferences.length : 'no'}. The appended reporter is last (${results.js.appendedLast && results.ts.appendedLast}).`
  );
}

/** A balanced run of the paths project through a resolving wrapper, the Action's files in its own folder. */
function wrapperRun(
  ctx,
  name,
  { shard = () => ({}), userFile = 'playwright.config.js', shards = 3 } = {}
) {
  return ctx.once(`sb-run:${name}`, () => {
    const cwd = pathsProject(ctx);
    const actionDir = ctx.dir(`action-run-${name}`);
    const timings = path.join(actionDir, 'timings', 'shard-timings.json');
    fs.mkdirSync(path.dirname(timings), { recursive: true });
    fs.copyFileSync(ctx.baseline().timings, timings);
    const record = path.join(actionDir, 'records', 'run-{shard}.json');
    const config = wrapper(ctx, `run-${name}`, {
      userConfig: path.join(cwd, userFile),
      options: { timings, record, workers: 1 },
    });
    const partition = Array.from({ length: shards }, (_, i) => {
      const own = shard(i + 1) || {};
      return {
        args: [`--shard=${i + 1}/${shards}`, ...(own.args || [])],
        env: { PSP_PSB_RECORD: record },
      };
    });
    const run = ctx.runPartition({ name: `wrapper-${name}`, cwd, partition, workers: 1, config });
    return { run, cwd, actionDir, timings };
  });
}

function wrapperRunRow(ctx) {
  const { run, cwd, actionDir, timings } = wrapperRun(ctx, 'balanced');
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    strategies: strategies(run),
    timingsShaMatches: run.plans.every((p) => p && p.timingsSha === sha12(timings)),
    checkExit: checked.status,
    jsonReportInProject: fs.existsSync(path.join(cwd, 'reports', 'run.json')),
    outputInProject: fs.existsSync(path.join(cwd, 'results')),
    nothingInActionFolder: !['reports', 'results', 'test-results'].some((d) =>
      fs.existsSync(path.join(actionDir, d))
    ),
  };
  return row(
    'sb.wrapper-run',
    "Through the resolving wrapper the fixture balances from the timings where the Action puts them, every leaf runs once, and the user's outputs land in the user's folders.",
    facts.harnessOk &&
      facts.strategies.every((s) => s === 'balanced') &&
      facts.timingsShaMatches &&
      facts.checkExit === 0 &&
      facts.jsonReportInProject &&
      facts.outputInProject &&
      facts.nothingInActionFolder,
    facts,
    `Three shards through the wrapper: violations ${kindsText(facts.violations)}, every shard balanced from the Action's timings file (sha matches: ${facts.timingsShaMatches}), \`check\` exit ${facts.checkExit}. The user's JSON report and output folder are in the project (${facts.jsonReportInProject && facts.outputInProject}) and none in the Action's folder (${facts.nothingInActionFolder}).`
  );
}

function cliReporter(ctx) {
  const { run } = wrapperRun(ctx, 'cli-reporter', {
    shard: (index) => (index === 2 ? { args: ['--reporter=list'] } : {}),
  });
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    recordsWritten: run.records.map(Boolean),
    planLines: run.plans.map(Boolean),
    checkExit: checked.status,
    namesMissing: (checked.json ? checked.json.problems : []).includes(
      'missing records for shard 2'
    ),
  };
  return row(
    'sb.cli-reporter',
    'A `--reporter` flag on the command line replaces the reporters of the wrapper, the injected one with them, and the aggregate check turns that into a red run.',
    !facts.recordsWritten[1] && !facts.planLines[1] && facts.checkExit === 1 && facts.namesMissing,
    facts,
    `\`--reporter=list\` on shard 2: that shard logged no plan and wrote no record, the harness found ${kindsText(facts.violations)}, and \`check\` exits ${facts.checkExit} with \`missing records for shard 2\`.`
  );
}

function addReporter(ctx) {
  const cwd = pathsProject(ctx);
  const user = path.join(cwd, 'playwright.config.js');
  // The reporter's default timings path is relative to the config file: the user's folder.
  fs.copyFileSync(ctx.baseline().timings, path.join(cwd, 'shard-timings.json'));
  const injected = `--add-reporter=${HARNESS_REPORTER},${reporterPath()}`;
  const partition = [1, 2, 3].map((i) => ({
    args: [`--shard=${i}/3`, '--reporter=list', injected],
  }));
  const run = ctx.runPartition({
    name: 'add-reporter-3',
    cwd,
    partition,
    workers: 1,
    config: user,
  });
  const listed = (args) =>
    drive
      .logLines(
        drive.playwright({ cwd, args: ['--list', `--config=${user}`, '--shard=1/3', ...args] })
          .output
      )
      .some((line) => drive.parsePlanLine(line));
  const facts = {
    ...harnessFacts(run),
    planLines: run.plans.map(Boolean),
    actionLast: listed([`--add-reporter=${reporterPath()}`]),
    userAddReporterLast: listed([`--add-reporter=${reporterPath()}`, '--add-reporter=dot']),
    merged: listed([`--add-reporter=dot,${reporterPath()}`]),
  };
  return row(
    'sb.add-reporter',
    "The reporter passed with `--add-reporter` balances with the user's config untouched and survives a `--reporter` flag; a later `--add-reporter` replaces it, so the Action must merge the user's into its own value.",
    facts.harnessOk &&
      facts.planLines.every(Boolean) &&
      facts.actionLast &&
      !facts.userAddReporterLast &&
      facts.merged,
    facts,
    `Three shards with \`--reporter=list\` and the reporter in \`--add-reporter\`: every shard logged a plan (${facts.planLines.every(Boolean)}), violations ${kindsText(facts.violations)}. A second \`--add-reporter=dot\` after it drops it (plan logged: ${facts.userAddReporterLast}); one merged value keeps it (${facts.merged}). Options cannot travel on the command line, so playwright-shard-balancer reads its timings from the default path next to the config and writes no record.`
  );
}

function tsConfig(ctx) {
  const { run } = wrapperRun(ctx, 'ts', { userFile: 'playwright.ts.config.ts', shards: 2 });
  const facts = { ...harnessFacts(run), strategies: strategies(run) };
  return row(
    'sb.ts-config',
    "A TypeScript config loads through the JavaScript wrapper with Playwright's own loader, and the run balances.",
    facts.harnessOk && facts.strategies.every((s) => s === 'balanced'),
    facts,
    `\`playwright.ts.config.ts\` required by the generated \`.js\` wrapper: two shards, ${facts.strategies.join(' and ')}, violations ${kindsText(facts.violations)}.`
  );
}

function shapesRows(ctx) {
  return [
    planRunRow(ctx),
    checkList(ctx),
    refusals(ctx),
    fallbackRepeat(ctx),
    fallbackHelper(ctx),
    planDamaged(ctx),
    reportHistory(ctx),
    wrapperNaive(ctx),
    wrapperPaths(ctx),
    wrapperRunRow(ctx),
    cliReporter(ctx),
    addReporter(ctx),
    tsConfig(ctx),
  ];
}

module.exports = { configDifferences, differences, shapesRows };
