'use strict';

/**
 * The Playwright internals the engines read (rows `i.*`): what the public reporter API shows of
 * serial groups, parallel modes and locks, what native sharding does with a lock, and what each
 * reporter does when an internal field is gone. A field that a Playwright release removes is
 * simulated by a copy of the reporter in which the read names a property that does not exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const flakiness = require('../../../qualification/flakiness/context');
const { scrub } = require('../../../qualification/flakiness/playwright');
const drive = require('../drive');
const { FLAKINESS, mutatedCopy } = require('../upstream');
const { filesWhole, strategies } = require('./assignment');
const { harnessFacts, kindsText, row } = require('./row');

const PROBE = path.resolve(__dirname, '..', 'lib', 'probe-reporter.js');
const MODE_LINE = "test.describe.configure({ mode: 'parallel' });";
const LOCK = "{ lock: 'database' }";

const lockSpec = (name) => `'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

test('${name} writes the database', ${LOCK}, async () => {
  await sleep(400);
});

test('${name} reads the catalog', async () => {
  await sleep(300);
});
`;

const FILLER = `'use strict';

const { test } = require('@playwright/test');
const { sleep } = require('./support');

test('filler one', async () => {
  await sleep(800);
});

test('filler two', async () => {
  await sleep(800);
});
`;

/** Edits that replace every spec file of the fixture with `files`. */
function onlySpecs(ctx, files) {
  const edits = { ...files };
  for (const file of fs.readdirSync(path.join(ctx.cwd, 'tests'))) {
    if (file.endsWith('.spec.js') && !(`tests/${file}` in files)) edits[`tests/${file}`] = null;
  }
  return edits;
}

function lockProject(ctx, { locked = true } = {}) {
  const name = locked ? 'variant-locks' : 'variant-no-locks';
  return ctx.once(name, () => {
    const edit = (text) => (locked ? text : text.replace(LOCK, '{}'));
    return ctx.copy(
      name,
      onlySpecs(ctx, {
        'tests/filler.spec.js': FILLER,
        'tests/lock-a.spec.js': edit(lockSpec('a')),
        'tests/lock-b.spec.js': edit(lockSpec('b')),
      })
    );
  });
}

/** The fixture with the parallel-mode line of the checkout spec blanked, all lines kept. */
function modelessProject(ctx) {
  return ctx.once('variant-modeless', () => {
    const text = fs.readFileSync(path.join(ctx.cwd, 'tests', 'checkout.spec.js'), 'utf8');
    if (!text.includes(MODE_LINE)) throw new Error('checkout.spec.js has no parallel mode line');
    return ctx.copy('variant-modeless', {
      'tests/checkout.spec.js': text.replace(MODE_LINE, '// mode line removed'),
    });
  });
}

/** What the probe reporter sees of a project: `--list` with the probe as the only reporter. */
function probe(ctx, cwd, name) {
  return ctx.once(`probe:${name}`, () => {
    const out = path.join(ctx.dir(`probe-${name}`), 'probe.json');
    const listed = drive.playwright({
      cwd,
      args: ['--list', `--config=${ctx.config(cwd)}`, `--reporter=${PROBE}`],
      env: { PSP_PSB_PLAIN: '1', PSP_PROBE_OUT: out },
    });
    if (!fs.existsSync(out)) throw new Error(`probe wrote nothing: ${listed.output.slice(0, 300)}`);
    return JSON.parse(fs.readFileSync(out, 'utf8')).tests;
  });
}

const inFile = (tests, file) => tests.filter((t) => t.key.startsWith(`${file} ›`));

function serialPublic(ctx) {
  const tests = probe(ctx, ctx.cwd, 'fixture');
  const leaves = ctx.listing().leaves;
  const harnessSerial = new Set(
    leaves
      .filter((l) => l.serialGroup)
      .map((l) => `${l.project} ${[l.specFile, ...l.titlePath].join(' › ')}`)
  );
  const annotated = tests.filter((t) => t.publicView.annotations.some((a) => a.type === 'serial'));
  const annotatedKeys = new Set(annotated.map((t) => `${t.project} ${t.key}`));
  const facts = {
    annotatedTests: annotated.length,
    harnessSerialLeaves: harnessSerial.size,
    sameTests:
      annotatedKeys.size === harnessSerial.size &&
      [...annotatedKeys].every((k) => harnessSerial.has(k)),
    withLocation: annotated.every(
      (t) => t.publicView.annotations.find((a) => a.type === 'serial').location
    ),
  };
  return row(
    'i.serial-public',
    'Playwright marks every test inside a serial describe with a public `serial` annotation that carries the location of the describe.',
    facts.sameTests && facts.withLocation && facts.annotatedTests > 0,
    facts,
    `${facts.annotatedTests} tests carry the annotation, the same tests the harness counts as serial (${facts.harnessSerialLeaves}), each with the location of its describe.`
  );
}

/** The internal `_parallelMode` of the file suite of a probed test. */
function fileMode(test) {
  return test.internal.parallelModes[test.publicView.parents.findIndex((p) => p.type === 'file')];
}

function modeHidden(ctx) {
  const withMode = inFile(probe(ctx, ctx.cwd, 'fixture'), 'checkout.spec.js');
  const without = inFile(probe(ctx, modelessProject(ctx), 'modeless'), 'checkout.spec.js');
  const facts = {
    tests: withMode.length,
    samePublicView:
      JSON.stringify(withMode.map((t) => t.publicView)) ===
      JSON.stringify(without.map((t) => t.publicView)),
    fileModeWith: fileMode(withMode[0]),
    fileModeWithout: fileMode(without[0]),
  };
  return row(
    'i.mode-hidden',
    '`describe.configure({ mode })` leaves no trace in the public reporter API; only the internal `_parallelMode` differs.',
    facts.samePublicView && facts.fileModeWith !== facts.fileModeWithout,
    facts,
    `The ${facts.tests} checkout tests with and without \`mode: 'parallel'\` have the same public view (${facts.samePublicView}); the file suite's \`_parallelMode\` is \`${facts.fileModeWith}\` against \`${facts.fileModeWithout}\`.`
  );
}

function lockHidden(ctx) {
  const locked = probe(ctx, lockProject(ctx), 'locks');
  const unlocked = probe(ctx, lockProject(ctx, { locked: false }), 'no-locks');
  const facts = {
    tests: locked.length,
    samePublicView:
      JSON.stringify(locked.map((t) => t.publicView)) ===
      JSON.stringify(unlocked.map((t) => t.publicView)),
    lockedTests: locked.filter((t) => t.internal.locks && t.internal.locks.length > 0).length,
    unlockedTests: unlocked.filter((t) => t.internal.locks && t.internal.locks.length > 0).length,
  };
  return row(
    'i.lock-hidden',
    'A test lock leaves no trace in the public reporter API; only the internal `_locks` differs.',
    facts.samePublicView && facts.lockedTests > 0 && facts.unlockedTests === 0,
    facts,
    `The ${facts.tests} tests with and without \`${LOCK}\` have the same public view (${facts.samePublicView}); \`_locks\` is set on ${facts.lockedTests} tests in one and ${facts.unlockedTests} in the other.`
  );
}

/** The shards that ran a test holding the lock. */
function lockShards(run) {
  return run.raw
    .filter((shard) =>
      (shard.leaves || []).some((leaf) => / writes the database$/.test(leaf.titlePath.join(' › ')))
    )
    .map((shard) => shard.index);
}

function lockNativeSplit(ctx) {
  const run = ctx.native(2, { cwd: lockProject(ctx), name: 'locks-plain-2' });
  const facts = { ...harnessFacts(run), shardsWithLock: lockShards(run) };
  return row(
    'i.lock-native-split',
    "Playwright's own sharding puts tests that share a lock on different shards, so a lock holds only inside one shard.",
    facts.harnessOk && facts.shardsWithLock.length > 1,
    facts,
    `Two native shards of a suite whose four tests across two files and two projects share one lock: the lock tests ran on shards ${facts.shardsWithLock.join(' and ')}.`
  );
}

function lockBaseline(ctx) {
  return ctx.baseline({ name: 'locks-native', cwd: lockProject(ctx) });
}

function lockRun(ctx, name, reporter) {
  return ctx.run({
    name,
    shards: 2,
    cwd: lockProject(ctx),
    timings: lockBaseline(ctx).timings,
    workers: 1,
    reporter,
  });
}

function psbLocks(ctx) {
  const run = lockRun(ctx, 'locks-balanced-2');
  const plan = run.plans[0] || { notes: [] };
  const facts = {
    ...harnessFacts(run),
    strategies: strategies(run),
    shardsWithLock: lockShards(run),
    notes: plan.notes,
  };
  return row(
    'i.psb-locks',
    'The reporter keeps every test that shares a lock on one shard.',
    facts.harnessOk &&
      facts.shardsWithLock.length === 1 &&
      facts.notes.some((n) => /share a lock/.test(n)),
    facts,
    `Balanced over two shards, the lock tests ran on shard ${facts.shardsWithLock.join(', ')} only, and the plan line says \`${facts.notes.join(', ')}\`.`
  );
}

function psbNoLocks(ctx) {
  const copy = ctx.once('psb-no-locks', () =>
    mutatedCopy({ dir: ctx.dir('psb-no-locks'), search: '_locks', replace: '_locksRemoved' })
  );
  const run = lockRun(ctx, 'locks-no-locks-2', path.join(copy.root, 'dist', 'reporter.js'));
  const plan = run.plans[0] || { notes: [] };
  const facts = {
    ...harnessFacts(run),
    replacements: copy.replacements,
    strategies: strategies(run),
    shardsWithLock: lockShards(run),
    notes: plan.notes,
  };
  return row(
    'i.psb-no-locks',
    'Without `_locks` the reporter still balances, says that lock groups may split, and lets them split.',
    facts.strategies.every((s) => s === 'balanced') &&
      facts.notes.some((n) => /^lock information not found/.test(n)) &&
      facts.shardsWithLock.length > 1,
    facts,
    `A copy whose read of \`_locks\` names a missing property: the shards exit ${facts.exitCodes.join(' / ')}, balance, and the lock tests ran on shards ${facts.shardsWithLock.join(' and ')}. The plan line says \`${facts.notes.join(', ')}\`; harness violations ${kindsText(facts.violations)}.`
  );
}

/** Facts of a run of a modified reporter, next to the unmodified and the native runs. */
function internalFacts(run, { unmodified, native, logLines, replacements }) {
  return {
    ...harnessFacts(run),
    replacements,
    serialSplit: run.summary.kinds['serial-split'] || 0,
    balances: !drive.sameSplit(run, native),
    sameSplitAsUnmodified: drive.sameSplit(run, unmodified),
    splitFiles: filesWhole(run),
    unmodifiedSplitFiles: filesWhole(unmodified),
    logLines,
  };
}

function psbNoParallelMode(ctx) {
  const copy = ctx.once('psb-no-mode', () =>
    mutatedCopy({
      dir: ctx.dir('psb-no-mode'),
      search: '_parallelMode',
      replace: '_parallelModeRemoved',
    })
  );
  const reporter = path.join(copy.root, 'dist', 'reporter.js');
  const configs = {};
  for (const fullyParallel of [false, true]) {
    const run = ctx.run({
      name: `psb-no-mode-3${fullyParallel ? '-fp' : ''}`,
      shards: 3,
      timings: ctx.baseline().timings,
      workers: 1,
      fullyParallel,
      reporter,
    });
    configs[fullyParallel ? 'fullyParallel' : 'default'] = {
      ...internalFacts(run, {
        unmodified: ctx.balanced(3, { fullyParallel }),
        native: ctx.native(3, { fullyParallel }),
        logLines: run.plans.map((p) => (p ? p.notes.join(', ') : null)),
        replacements: copy.replacements,
      }),
      strategies: strategies(run),
      granularity: run.records.map((r) => r && r.data.granularity),
    };
  }
  const ok = (c) =>
    c.harnessOk &&
    c.balances &&
    c.splitFiles === 0 &&
    c.logLines.every((l) => /Playwright internals not found so files are kept whole/.test(l || ''));
  const facts = configs;
  return row(
    'i.psb-no-parallel-mode',
    'Without `_parallelMode` the reporter keeps whole files, still balances, runs every leaf once and says so in its log line.',
    ok(configs.default) && ok(configs.fullyParallel),
    facts,
    `A copy whose ${copy.replacements} reads of \`_parallelMode\` name a missing property. Default config: exit ${configs.default.exitCodes.join(' / ')}, balanced (${configs.default.balances}), ${configs.default.splitFiles} files split, violations ${kindsText(configs.default.violations)}. \`fullyParallel\`: exit ${configs.fullyParallel.exitCodes.join(' / ')}, balanced (${configs.fullyParallel.balances}), ${configs.fullyParallel.splitFiles} files split, violations ${kindsText(configs.fullyParallel.violations)}. Every shard logs \`${configs.default.logLines[0]}\`.`
  );
}

/** The plan lines the Flakiness reporter prints for a shard, each path reduced to its file name. */
function flakinessLines(output) {
  return drive
    .plain(output || '')
    .split('\n')
    .filter((line) => /^\[flakiness\.io\]\s+(balancing|duration hints|Running shard)/.test(line))
    .map((line) => scrub(line.replace(/\s+/g, ' ').trim()));
}

/** Clears the Flakiness variables of the developer's environment before any Flakiness run. */
function clearFlakinessEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('FLAKINESS_') || name.startsWith('PSP_FLK_')) delete process.env[name];
  }
}

function flakinessNoParallelMode(ctx) {
  clearFlakinessEnvironment();
  const copy = ctx.once('flk-no-mode', () =>
    mutatedCopy({
      dir: ctx.dir('flk-no-mode'),
      from: FLAKINESS,
      file: 'lib/playwright-test.js',
      search: '_parallelMode',
      replace: '_parallelModeRemoved',
    })
  );
  const reporter = path.join(copy.root, 'lib', 'playwright-test.js');
  const flk = flakiness.createContext({ log: ctx.log });
  try {
    const configs = {};
    for (const fullyParallel of [false, true]) {
      const baseline = flk.baseline({
        fullyParallel,
        name: fullyParallel ? 'native2-fp' : 'native2',
      });
      const unmodified = flk.balancedRun(3, { fullyParallel });
      const run = flk.run({
        name: `flk-no-mode-3${fullyParallel ? '-fp' : ''}`,
        shards: 3,
        timings: baseline.history.file,
        workers: 1,
        fullyParallel,
        env: { PSP_FLK_REPORTER: reporter },
      });
      configs[fullyParallel ? 'fullyParallel' : 'default'] = internalFacts(run, {
        unmodified,
        native: ctx.native(3, { fullyParallel }),
        logLines: run.raw.map((shard) => flakinessLines(shard.output).join(' | ')),
        replacements: copy.replacements,
      });
      configs[fullyParallel ? 'fullyParallel' : 'default'].warns = run.raw.some((shard) =>
        /\[flakiness\.io\].*(parallel ?mode|internal)/i.test(drive.plain(shard.output || ''))
      );
    }
    const ok = (c) => c.harnessOk && c.balances && c.splitFiles === 0;
    return row(
      'i.flakiness-no-parallel-mode',
      'Without `_parallelMode` the Flakiness reporter keeps whole files, still balances and runs every leaf once.',
      ok(configs.default) && ok(configs.fullyParallel),
      configs,
      `A copy of \`@flakiness/playwright\` whose ${copy.replacements} read of \`_parallelMode\` names a missing property. Default config: exit ${configs.default.exitCodes.join(' / ')}, balanced (${configs.default.balances}), ${configs.default.splitFiles} files split, violations ${kindsText(configs.default.violations)}. \`fullyParallel\`: exit ${configs.fullyParallel.exitCodes.join(' / ')}, balanced (${configs.fullyParallel.balances}), ${configs.fullyParallel.splitFiles} files split where the unmodified reporter split ${configs.fullyParallel.unmodifiedSplitFiles}, violations ${kindsText(configs.fullyParallel.violations)}. It prints no warning about the missing field (${!configs.default.warns && !configs.fullyParallel.warns}).`
    );
  } finally {
    if (!process.env.PSP_KEEP_TMP) flk.dispose();
  }
}

/** Where the installed Flakiness reporter reads `_parallelMode`: file, line and the line itself. */
function flakinessRead() {
  const file = path.join(FLAKINESS, 'lib', 'playwright-test.js');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const fn = lines.findIndex((line) => line.startsWith('function computeTestGroupSuite('));
  const read = lines.findIndex((line, i) => i > fn && line.includes('._parallelMode'));
  const version = JSON.parse(fs.readFileSync(path.join(FLAKINESS, 'package.json'), 'utf8')).version;
  return {
    package: `@flakiness/playwright@${version}`,
    file: 'lib/playwright-test.js',
    function: 'computeTestGroupSuite',
    functionLine: fn + 1,
    line: read + 1,
    quote: lines[read].trim(),
    reads: lines.filter((line) => line.includes('_parallelMode')).length,
    locksRead: lines.some((line) => line.includes('._locks')),
  };
}

function flakinessInternal() {
  const facts = flakinessRead();
  return row(
    'i.flakiness-internal',
    '`@flakiness/playwright` groups tests by reading the internal `_parallelMode` of each parent suite.',
    facts.functionLine > 0 && facts.line > facts.functionLine && facts.reads === 1,
    facts,
    `\`${facts.package}\` reads it once, in \`${facts.function}\` at \`${facts.file}:${facts.line}\`: \`${facts.quote}\`. It reads no \`_locks\` (${!facts.locksRead}).`
  );
}

function internalsRows(ctx) {
  return [
    serialPublic(ctx),
    modeHidden(ctx),
    lockHidden(ctx),
    lockNativeSplit(ctx),
    psbLocks(ctx),
    psbNoLocks(ctx),
    psbNoParallelMode(ctx),
    flakinessInternal(),
    flakinessNoParallelMode(ctx),
  ];
}

module.exports = { flakinessRead, internalsRows, lockProject };
