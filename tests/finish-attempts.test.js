'use strict';

/**
 * Re-runs and the finish action, through the local model of support/model.js with real
 * Playwright: a shard job that started in an attempt and left no record (Playwright stopped
 * before it loaded the reporter, the job was cancelled before its post step, or the upload of its
 * record failed) keeps the earlier record of its shard from standing, while a shard that was not
 * re-run keeps its earlier record and a newer record replaces an older one, failed or missing.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finishJob, mainStep, newWorld, shardJob } = require('./support/model');
const { FIXTURE, requireFixture } = require('./support/fixture');

/** A browser-free project with two spec files; `FAIL=<title>` fails that test. */
function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-attempts-'));
  fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(ws, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(FIXTURE, 'package-lock.json'), path.join(ws, 'package-lock.json'));
  fs.writeFileSync(
    path.join(ws, 'playwright.config.js'),
    `module.exports = { testDir: '.', workers: 1, reporter: 'dot', projects: [{ name: 'p' }] };\n`
  );
  for (const name of ['a', 'b']) {
    fs.writeFileSync(
      path.join(ws, `${name}.spec.js`),
      `const { test } = require('@playwright/test');\n` +
        `test('${name}', async () => {\n` +
        `  if (process.env.FAIL === '${name}') throw new Error('fails on purpose');\n});\n`
    );
  }
  return ws;
}

const CLI = 'node node_modules/@playwright/test/cli.js test';
const good = (shard) => `${CLI} --shard=${shard}/2 $PSP_ARGS`;
const broken = (shard) => `${CLI} --config=missing.config.js --shard=${shard}/2 $PSP_ARGS`;

let runs = 900;
function newRun() {
  const world = newWorld();
  const runId = ++runs;
  const job = (shard, attempt, command = good, options = {}) =>
    shardJob({ ws: workspace(), world }, { runId, attempt, command: command(shard), ...options });
  const finish = (attempt) =>
    finishJob({ ws: workspace(), world }, { runId, env: { GITHUB_RUN_ATTEMPT: String(attempt) } });
  return { world, runId, job, finish };
}

const attemptsOf = (finished) =>
  finished.result.groups.flatMap((g) => g.check.records.map((r) => r.run.attempt));
const problemsOf = (finished) => finished.result.groups.flatMap((g) => g.check.problems);

before(() => requireFixture());

describe('a shard job that started and left no record', () => {
  test('a re-run of all shards that stops before Playwright loads the reporter fails finish', async () => {
    const run = newRun();
    for (const shard of [1, 2]) assert.strictEqual((await run.job(shard, 1)).user.status, 0);
    for (const shard of [1, 2]) {
      const job = await run.job(shard, 2, broken);
      assert.strictEqual(job.user.status, 1);
      assert.match(job.post.warnings.join('\n'), /no run record/);
    }
    const finished = await run.finish(2);
    assert.strictEqual(finished.result.ok, false);
    assert.strictEqual(finished.result.coverage, 'failed');
    assert.ok(
      problemsOf(finished).some((p) =>
        /2 shard job\(s\) of attempt 2 left no record.*shard 1, 2 cannot stand/.test(p)
      ),
      problemsOf(finished).join('\n')
    );
  });

  test('a shard cancelled before its post step fails finish', async () => {
    const run = newRun();
    for (const shard of [1, 2]) await run.job(shard, 1);
    // The main step ran; the job was cancelled before the user step and the post step.
    const main = await mainStep(
      { ws: workspace(), world: run.world },
      { runId: run.runId, attempt: 2 }
    );
    assert.strictEqual(main.error, null);
    const finished = await run.finish(2);
    assert.strictEqual(finished.result.ok, false);
    assert.ok(
      problemsOf(finished).some((p) => /1 shard job\(s\) of attempt 2 left no record/.test(p))
    );
  });

  test('a shard whose record upload fails fails finish', async () => {
    const run = newRun();
    for (const shard of [1, 2]) await run.job(shard, 1);
    run.world.before = async (op, name) => {
      if (op === 'upload' && /^psp-record-.*-attempt-2$/.test(name)) {
        throw new Error('(503) the artifact service is unavailable');
      }
    };
    const job = await run.job(2, 2);
    run.world.before = null;
    assert.strictEqual(job.user.status, 0);
    assert.match(job.post.warnings.join('\n'), /could not be uploaded/);
    const finished = await run.finish(2);
    assert.strictEqual(finished.result.ok, false);
    assert.ok(problemsOf(finished).some((p) => /of attempt 2 left no record/.test(p)));
  });

  test('a job whose every shard left no record fails finish with what to check', async () => {
    const run = newRun();
    for (const shard of [1, 2]) await run.job(shard, 1, broken);
    const finished = await run.finish(1);
    assert.strictEqual(finished.result.ok, false);
    assert.match(
      finished.io.summaryText,
      /started in attempt 1 and no shard of its job left a record/
    );
  });

  test('a later attempt that cannot say which shard it was fails finish', async () => {
    const run = newRun();
    for (const shard of [1, 2]) await run.job(shard, 1);
    await run.job(2, 2, broken);
    await run.job(2, 3);
    // Attempt 2 started one shard that left no record; it may have been shard 1.
    const finished = await run.finish(3);
    assert.strictEqual(finished.result.ok, false);
    assert.ok(problemsOf(finished).some((p) => /attempt 2 left no record.*shard 1 cannot/.test(p)));
  });
});

describe('records of earlier attempts that may stand', () => {
  test('a re-run of shard 2 only keeps the record shard 1 left in attempt 1', async () => {
    const run = newRun();
    for (const shard of [1, 2]) await run.job(shard, 1);
    assert.strictEqual((await run.job(2, 2)).user.status, 0);
    const finished = await run.finish(2);
    assert.strictEqual(finished.result.ok, true, problemsOf(finished).join('\n'));
    assert.deepStrictEqual(attemptsOf(finished), [1, 2]);
  });

  test('a passing replacement of a failed shard wins, and the failed record taints nothing', async () => {
    const run = newRun();
    await run.job(1, 1);
    const failed = await run.job(2, 1, good, { env: { FAIL: 'b' } });
    assert.strictEqual(failed.user.status, 1);
    assert.strictEqual((await run.finish(1)).result.ok, false);
    await run.job(2, 2);
    const finished = await run.finish(2);
    assert.strictEqual(finished.result.ok, true, problemsOf(finished).join('\n'));
    assert.strictEqual(finished.result.coverage, 'ok');
    assert.deepStrictEqual(attemptsOf(finished), [1, 2]);
  });

  test('a shard that left no record in attempt 1 and passed in attempt 2 is proven', async () => {
    const run = newRun();
    await run.job(1, 1);
    await run.job(2, 1, broken);
    assert.strictEqual((await run.finish(1)).result.ok, false);
    await run.job(2, 2);
    const finished = await run.finish(2);
    assert.strictEqual(finished.result.ok, true, problemsOf(finished).join('\n'));
    assert.deepStrictEqual(attemptsOf(finished), [1, 2]);
  });
});
