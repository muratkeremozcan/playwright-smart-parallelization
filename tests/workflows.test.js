/**
 * Tests for the end-to-end pipeline workflow. Its seed jobs are skipped in most legs, and a job
 * whose `if:` has no status function gets an implicit success() that is false when any job it
 * needs, directly or through other jobs, was skipped. Every job that depends on a job that can be
 * skipped must therefore say when it runs.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const file = path.join(__dirname, '..', '.github', 'workflows', 'e2e-pipeline.yml');
const { jobs } = YAML.parse(fs.readFileSync(file, 'utf8'));

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
  assert.ok(skippable.includes('seed'), 'the seed job is conditional');
  for (const name of Object.keys(jobs)) {
    const below = [...ancestors(name)].filter((a) => skippable.includes(a));
    if (below.length === 0) continue;
    assert.ok(
      hasStatusFunction(jobs[name].if),
      `${name} needs ${below.join(', ')}, which can be skipped, so its if: needs a status function`
    );
  }
});

test('the shard job contains a failure on purpose at job level', () => {
  assert.match(String(jobs.test['continue-on-error']), /inputs\.fail-test/);
});
