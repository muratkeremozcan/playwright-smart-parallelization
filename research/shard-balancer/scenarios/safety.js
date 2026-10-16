'use strict';

/**
 * What the reporter does with input it cannot trust (rows `s.*`), and what `check` catches over
 * the records of a run (rows `c.*`). Each experiment gives one shard a different input or command
 * line, runs it through the harness and then runs `check` over the records the shards wrote.
 */

const fs = require('node:fs');
const path = require('node:path');
const { scrub } = require('../../../qualification/flakiness/playwright');
const drive = require('../drive');
const { checkRun, strategies } = require('./assignment');
const { harnessFacts, kindsText, row } = require('./row');

const STRICT = { PLAYWRIGHT_SHARD_BALANCER_STRICT: '1' };

// Fails at once and retries, so a run with `--max-failures=1` stops at the first test file.
const FAILING = `'use strict';

const { test, expect } = require('@playwright/test');

test('fails first', async () => {
  expect(1).toBe(2);
});
`;

/** A truncated copy of the baseline timings: no longer JSON. */
function damagedTimings(ctx) {
  return ctx.once('damaged-timings', () => {
    const file = path.join(ctx.dir('damaged'), 'timings.json');
    const text = fs.readFileSync(ctx.baseline().timings, 'utf8');
    fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
    return file;
  });
}

/** A valid copy of the baseline timings in which the cart tests take twenty times as long. */
function scaledTimings(ctx) {
  return ctx.once('scaled-timings', () => {
    const file = path.join(ctx.dir('scaled'), 'timings.json');
    const timings = drive.readTimings(ctx.baseline().timings);
    for (const [key, entry] of Object.entries(timings.tests)) {
      if (key.includes(' › cart.spec.js › ')) entry.samples = entry.samples.map((s) => s * 20);
    }
    fs.writeFileSync(file, `${JSON.stringify(timings, null, 1)}\n`);
    return file;
  });
}

/** The first line of a shard's output that matches `pattern`, or null. */
function lineOf(output, pattern) {
  return (
    drive
      .plain(output)
      .split('\n')
      .find((line) => pattern.test(line)) || null
  );
}

const ranNothing = (shard) => !shard.leaves || shard.leaves.length === 0;

function problemsOf(checked) {
  return checked.json ? checked.json.problems : [checked.stderr.trim().split('\n')[0]];
}

function failOpenDamaged(ctx) {
  const timings = ctx.baseline().timings;
  const damaged = damagedTimings(ctx);
  const run = ctx.run({
    name: 'failopen-damaged-3',
    shards: 3,
    timings,
    shard: (index) => (index === 2 ? { env: { PSP_PSB_TIMINGS: damaged } } : {}),
  });
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    strategies: strategies(run),
    reason: run.records[1] ? run.records[1].data.reason.split(':')[0] : null,
    checkExit: checked.status,
    checkNamesMixed: problemsOf(checked).some((p) =>
      p.startsWith('shards split the suite differently')
    ),
  };
  return row(
    's.failopen-damaged',
    'With strict off, a shard that cannot read its timings never splits the suite differently from the other shards.',
    facts.harnessOk,
    facts,
    `Shard 2 read a truncated copy and fell back to the built-in split while shards 1 and 3 balanced (${facts.strategies.join(', ')}). Every shard exited 0 and the harness found ${kindsText(facts.violations)}. \`check\` exits ${facts.checkExit} and names the mixed split, after the tests ran.`
  );
}

function strictDamaged(ctx) {
  const timings = ctx.baseline().timings;
  const damaged = damagedTimings(ctx);
  const run = ctx.run({
    name: 'strict-damaged-3',
    shards: 3,
    timings,
    env: STRICT,
    shard: (index) => (index === 2 ? { env: { PSP_PSB_TIMINGS: damaged } } : {}),
  });
  const message = lineOf(run.raw[1].output, /strict mode stops the run/);
  const facts = {
    ...harnessFacts(run),
    damagedShardRanNothing: ranNothing(run.raw[1]),
    otherShardsExit: [run.raw[0].exitCode, run.raw[2].exitCode],
    duplicates: run.summary.kinds.duplicate || 0,
    message: message && scrub(message.replace(/^Error: /, '')),
  };
  return row(
    's.strict-damaged',
    'With strict on, a shard that cannot read its timings fails before any test runs.',
    facts.exitCodes[1] !== 0 &&
      facts.damagedShardRanNothing &&
      facts.duplicates === 0 &&
      Boolean(message),
    facts,
    `Strict on, shard 2 reads a truncated copy: it exits ${facts.exitCodes[1]} before any test, with an error that names the file and says strict mode stopped the run. Shards 1 and 3 exit ${facts.otherShardsExit.join(' and ')}, and no test runs twice. The run is red.`
  );
}

function strictEmpty(ctx) {
  const emptyFile = path.join(ctx.dir('empty'), 'timings.json');
  fs.writeFileSync(emptyFile, '{"version":1,"tests":{}}\n');
  const absent = path.join(ctx.dir('absent'), 'timings.json');
  const empty = ctx.run({ name: 'strict-empty-2', shards: 2, timings: emptyFile, env: STRICT });
  const missing = ctx.run({ name: 'strict-absent-2', shards: 2, timings: absent, env: STRICT });
  const facts = {
    emptyExitCodes: empty.raw.map((s) => s.exitCode),
    absentExitCodes: missing.raw.map((s) => s.exitCode),
    ranNothing: [...empty.raw, ...missing.raw].every(ranNothing),
    emptyMessage: scrub((lineOf(empty.raw[0].output, /strict mode/) || '').replace(/^Error: /, '')),
  };
  return row(
    's.strict-empty',
    'With strict on, an empty or absent timings file fails every shard before any test, so a first run must keep strict off.',
    [...facts.emptyExitCodes, ...facts.absentExitCodes].every((code) => code !== 0) &&
      facts.ranNothing,
    facts,
    `Strict on with an empty timings file every shard exits ${facts.emptyExitCodes.join(' / ')}, and with no file ${facts.absentExitCodes.join(' / ')}, before any test, each with an error that says the file has no entries or is missing. The restore action turns strict on only when the pinned file has entries for this reason.`
  );
}

function mismatched(ctx) {
  const scaled = scaledTimings(ctx);
  const run = ctx.run({
    name: 'mismatched-3',
    shards: 3,
    timings: ctx.baseline().timings,
    shard: (index) => (index === 2 ? { env: { PSP_PSB_TIMINGS: scaled } } : {}),
  });
  const checked = checkRun(run);
  const problems = problemsOf(checked);
  const facts = {
    ...harnessFacts(run),
    checkExit: checked.status,
    namesTimings: problems.some((p) => p.startsWith('shards used different timings')),
    namesPlan: problems.some((p) => p.startsWith('shards used different plan')),
  };
  return row(
    's.mismatched',
    '`check` fails a run whose shards planned from different timings, naming the timings and the plan.',
    facts.checkExit === 1 && facts.namesTimings && facts.namesPlan,
    facts,
    `Shard 2 read a valid file in which the cart tests take twenty times as long. The shards exited ${facts.exitCodes.join(' / ')} and the harness found ${kindsText(facts.violations)}; \`check\` exits ${facts.checkExit} and names different timings (${facts.namesTimings}) and different plans (${facts.namesPlan}).`
  );
}

function reporterDropped(ctx) {
  const run = ctx.run({
    name: 'reporter-dropped-3',
    shards: 3,
    timings: ctx.baseline().timings,
    shard: (index) => (index === 2 ? { args: ['--reporter=list'] } : {}),
  });
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    recordsWritten: run.records.map(Boolean),
    checkExit: checked.status,
    namesMissing: problemsOf(checked).includes('missing records for shard 2'),
  };
  return row(
    's.reporter-dropped',
    '`check` fails a run in which one shard ran without the reporter.',
    facts.checkExit === 1 && facts.namesMissing,
    facts,
    `\`--reporter=list\` on shard 2 replaced the config's reporters, so that shard split natively and wrote no record. The shards exited ${facts.exitCodes.join(' / ')} with ${kindsText(facts.violations)}; \`check\` exits ${facts.checkExit} with \`missing records for shard 2\`.`
  );
}

/** What the finish action does with a records folder: it fails when the folder has no record. */
function finishRecords(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  return files.length === 0
    ? { status: 1, error: `no run records in ${path.basename(dir)}` }
    : { status: 0 };
}

function reporterDroppedAll(ctx) {
  const run = ctx.run({
    name: 'reporter-dropped-all-2',
    shards: 2,
    timings: ctx.baseline().timings,
    shard: () => ({ args: ['--reporter=list'] }),
  });
  const checked = drive.check([]);
  const finish = finishRecords(path.join(run.dir, 'records'));
  const facts = {
    ...harnessFacts(run),
    recordsWritten: run.records.map(Boolean),
    checkExit: checked.status,
    finishExit: finish.status,
  };
  return row(
    's.reporter-dropped-all',
    'When every shard runs without the reporter, the step after the shards cannot pass.',
    facts.recordsWritten.every((w) => !w) && facts.checkExit !== 0 && facts.finishExit !== 0,
    facts,
    `\`--reporter=list\` on both shards gave a native run with ${kindsText(facts.violations)} and no record. \`check\` with no record exits ${facts.checkExit}, and the finish action's own guard, which fails on an empty records folder, exits ${facts.finishExit}.`
  );
}

function missingRecord(ctx) {
  const run = ctx.balanced(2);
  const checked = drive.check([run.records[0].file]);
  const facts = {
    checkExit: checked.status,
    problems: problemsOf(checked).map((p) => p.split(':')[0]),
  };
  return row(
    'c.missing-record',
    '`check` fails when the record of a shard is missing.',
    facts.checkExit === 1 && checked.json.problems.includes('missing records for shard 2'),
    facts,
    `The record of shard 1 alone: exit ${facts.checkExit}, \`${checked.json.problems[0]}\`.`
  );
}

function duplicateRecord(ctx) {
  const run = ctx.balanced(2);
  const [one, two] = run.records.map((r) => r.file);
  const checked = drive.check([one, one, two]);
  const facts = {
    checkExit: checked.status,
    namesRepeat: checked.json.problems.includes('more than one record for shard 1'),
    duplicates: checked.json.duplicates.length,
  };
  return row(
    'c.duplicate-record',
    '`check` fails when a shard has two records, and counts the tests that ran twice.',
    facts.checkExit === 1 && facts.namesRepeat && facts.duplicates > 0,
    facts,
    `Shard 1's record given twice: exit ${facts.checkExit}, \`more than one record for shard 1\`, ${facts.duplicates} tests counted twice.`
  );
}

function notRun(ctx) {
  const cwd = ctx.once('variant:fails-first', () =>
    ctx.copy('variant-fails-first', { 'tests/aaa-fails.spec.js': FAILING })
  );
  const run = ctx.run({
    name: 'max-failures-2',
    cwd,
    shards: 2,
    workers: 1,
    timings: ctx.baseline().timings,
    forward: ['--max-failures=1'],
  });
  const checked = checkRun(run);
  const facts = {
    exitCodes: run.raw.map((s) => s.exitCode),
    recordsWritten: run.records.map(Boolean),
    checkExit: checked.status,
    notRun: checked.json ? checked.json.not_run.length : null,
  };
  return row(
    'c.not-run',
    '`check` fails a run stopped by `--max-failures` and counts the tests that did not run.',
    facts.checkExit === 1 && facts.notRun > 0 && facts.recordsWritten.every(Boolean),
    facts,
    `A test that fails first and \`--max-failures=1\`: the shards exited ${facts.exitCodes.join(' / ')} and both wrote a record; \`check\` exits ${facts.checkExit} with ${facts.notRun} tests that did not run.`
  );
}

function corpusMismatch(ctx) {
  const run = ctx.run({
    name: 'corpus-grep-2',
    shards: 2,
    timings: ctx.baseline().timings,
    shard: (index) => (index === 2 ? { args: ['--grep=cart'] } : {}),
  });
  const checked = checkRun(run);
  const facts = {
    ...harnessFacts(run),
    checkExit: checked.status,
    namesCorpus: problemsOf(checked).some((p) =>
      p.startsWith('shards saw different test sets before the split')
    ),
    corpora: run.records.map((r) => r && r.data.corpus.tests),
  };
  return row(
    'c.corpus-mismatch',
    '`check` fails a run whose shards saw different test sets before the split.',
    facts.checkExit === 1 && facts.namesCorpus,
    facts,
    `\`--grep=cart\` on shard 2 only: the records hold corpora of ${facts.corpora.join(' and ')} tests, the harness found ${kindsText(facts.violations)}, and \`check\` exits ${facts.checkExit} naming the different test sets.`
  );
}

function summary(ctx) {
  const run = ctx.balanced(3);
  const file = path.join(ctx.dir('summary'), 'summary.md');
  const checked = checkRun(run, { summary: file });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rows = text.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  const facts = {
    checkExit: checked.status,
    heading: text.split('\n')[0],
    header: text.split('\n').find((line) => line.startsWith('| Shard')) || null,
    shardRows: rows.length,
  };
  return row(
    'c.summary',
    '`check --summary` writes a table of predicted against measured time for every shard.',
    facts.checkExit === 0 && facts.shardRows === 3 && /Predicted/.test(facts.header || ''),
    facts,
    `Three shards: the summary starts \`${facts.heading}\` and has ${facts.shardRows} shard rows under \`${facts.header}\`.`
  );
}

function safetyRows(ctx) {
  return [
    failOpenDamaged(ctx),
    strictDamaged(ctx),
    strictEmpty(ctx),
    mismatched(ctx),
    reporterDropped(ctx),
    reporterDroppedAll(ctx),
  ];
}

function checkRows(ctx) {
  return [missingRecord(ctx), duplicateRecord(ctx), notRun(ctx), corpusMismatch(ctx), summary(ctx)];
}

module.exports = { STRICT, checkRows, damagedTimings, finishRecords, safetyRows };
