/**
 * Tests for the end-to-end pipeline workflow and the shard action it runs. Its warm job is
 * skipped in most legs, and a job whose `if:` has no status function gets an implicit success()
 * that is false when any job it needs, directly or through other jobs, was skipped. Every job that
 * depends on a job that can be skipped must therefore say when it runs.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const read = (file) => YAML.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const { jobs } = read('.github/workflows/e2e-pipeline.yml');
const shard = read('.github/actions/e2e-shard/action.yml');
const callers = read('.github/workflows/test.yml').jobs;

const needsOf = (name) => [jobs[name].needs ?? []].flat();
const hasStatusFunction = (condition) =>
  /\b(always|cancelled|failure|success)\(\)/.test(String(condition ?? ''));

/** The jobs `name` depends on, directly or through other jobs. */
function ancestors(name, seen = new Set()) {
  for (const need of needsOf(name)) {
    if (seen.has(need)) continue;
    seen.add(need);
    ancestors(need, seen);
  }
  return seen;
}

test('every job below a job that can be skipped states a status function', () => {
  const skippable = Object.keys(jobs).filter((name) => jobs[name].if !== undefined);
  assert.ok(skippable.includes('warm'), 'the warm job is conditional');
  for (const name of Object.keys(jobs)) {
    const below = [...ancestors(name)].filter((a) => skippable.includes(a));
    if (below.length === 0) continue;
    assert.ok(
      hasStatusFunction(jobs[name].if),
      `${name} needs ${below.join(', ')}, which can be skipped, so its if: needs a status function`
    );
  }
});

test('a shard runs the Action, then its own Playwright command with $PSP_ARGS in every shape', () => {
  const steps = shard.runs.steps;
  const action = steps.findIndex((s) => s.uses === './');
  assert.ok(action >= 0);
  for (const id of ['plain', 'shell', 'npm']) {
    const step = steps.find((s) => s.id === id);
    assert.ok(steps.indexOf(step) > action, id);
    assert.match(step.run, /--shard=.+ \$PSP_ARGS$/m, id);
    assert.strictEqual(step['working-directory'], 'fixtures/consumer');
    assert.strictEqual(step['continue-on-error'], true, 'the assert job judges a failing test');
  }
  assert.match(steps.find((s) => s.id === 'shell').run, /--grep "\$FILTER"/);
  assert.match(steps.find((s) => s.id === 'npm').run, /^npm run test:pw -- /);
  assert.strictEqual(steps[action].with.phase, undefined);
});

test('the legs cover cold and warm, eight shards, a re-run, a failure, rollback and the command shapes', () => {
  const legs = Object.fromEntries(
    Object.entries(callers)
      .filter(([, job]) => job.uses === './.github/workflows/e2e-pipeline.yml')
      .map(([name, job]) => [name, job.with])
  );
  assert.strictEqual(legs['e2e-cold-warm'].warm, true);
  assert.strictEqual(legs['e2e-eight'].shards, 8);
  assert.strictEqual(legs['e2e-eight'].barrier, true);
  assert.strictEqual(legs['e2e-rerun'].rerun, true);
  assert.ok(legs['e2e-failed']['fail-test']);
  assert.strictEqual(legs['e2e-failed']['expect-history'], 'published');
  assert.strictEqual(legs['e2e-rollback'].enabled, 'false');
  assert.strictEqual(legs['e2e-shell'].shape, 'shell');
  assert.strictEqual(legs['e2e-shell']['working-directory'], '');
  assert.strictEqual(legs['e2e-npm'].shape, 'npm');
  assert.strictEqual(legs['e2e-pr-head']['checkout-head'], true);
  assert.match(callers['e2e-pr-head'].if, /github\.event_name == 'pull_request'/);
});

test("the assert job holds the Action's step times to a budget, looser where every shard publishes at once", () => {
  const step = jobs.assert.steps.at(-1);
  assert.match(
    step.run,
    /^node tests\/e2e\/timing\.js leg "\$SHARD_BUDGET" "\$FINISH_BUDGET" "\$LEG_MEDIAN"$/
  );
  assert.ok(jobs.assert.needs.includes('finish'), 'the finish job has ended');
  const { inputs } = read('.github/workflows/e2e-pipeline.yml').on.workflow_call;
  assert.ok(callers['e2e-eight'].with['shard-budget'] > inputs['shard-budget'].default);
});

test('the median over every leg runs after every leg, and leaves out exactly the legs that hold their own', () => {
  const legs = Object.entries(callers).filter(
    ([, job]) => job.uses === './.github/workflows/e2e-pipeline.yml'
  );
  const timing = callers['e2e-timing'];
  assert.deepStrictEqual([...timing.needs].sort(), legs.map(([name]) => name).sort());
  assert.match(timing.if, /!cancelled\(\)/);
  for (const [, job] of legs)
    assert.match(job.name, /^e2e, /, 'runJobs finds a leg by its e2e, name');
  const run = timing.steps.at(-1).run;
  const [, budget, p90, rest] = /^node tests\/e2e\/timing\.js run (\d+) (\d+)((?: "[^"]+")*)$/.exec(
    run
  );
  assert.ok(Number(p90) > Number(budget));
  const excluded = [...rest.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const own = legs.filter(([, job]) => job.with['leg-median'] === true).map(([, job]) => job.name);
  assert.deepStrictEqual(excluded, own.sort());
  const { inputs } = read('.github/workflows/e2e-pipeline.yml').on.workflow_call;
  assert.strictEqual(Number(budget), inputs['shard-budget'].default);
  assert.strictEqual(inputs['leg-median'].default, false);
});
