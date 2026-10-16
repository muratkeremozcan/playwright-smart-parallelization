'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeRun } = require('../analyze');
const { loadRecords, render } = require('../render');

const root = path.join(__dirname, '..', '..');
const rawDir = path.join(root, 'docs', 'measurements', 'raw');
const docFile = path.join(root, 'docs', 'measurements', 'baseline.md');

const records = loadRecords(rawDir);
const doc = fs.readFileSync(docFile, 'utf8');

test('docs/measurements/baseline.md is exactly what the raw records render to', () => {
  assert.equal(doc, render(records));
});

test('every raw record is a first-attempt run that analyzes cleanly', () => {
  for (const record of records) {
    assert.equal(analyzeRun(record).id, record.run.id);
  }
  const ids = records.map((r) => r.run.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('each label has at least five runs with timings, as the measurement protocol asks', () => {
  const timed = {};
  for (const record of records) {
    timed[record.label] = timed[record.label] || 0;
    if (!analyzeRun(record).excluded) timed[record.label] += 1;
  }
  assert.ok(Object.keys(timed).length >= 1);
  for (const [label, count] of Object.entries(timed)) {
    assert.ok(count >= 5, `${label} has ${count} runs with timings`);
  }
});

test('tampering with the raw evidence changes the document', () => {
  const tamper = (mutate) => {
    const copy = JSON.parse(JSON.stringify(records));
    mutate(copy);
    return render(copy);
  };
  assert.notEqual(
    tamper(
      (r) =>
        (r[0].jobs.find((j) => j.name === 'merge-reports').completedAt = '2030-01-01T00:00:00Z')
    ),
    doc
  );
  assert.notEqual(
    tamper((r) => (r[0].shards[0].blob.tests[0].attempts[0].duration += 60000)),
    doc
  );
  assert.notEqual(
    tamper((r) => (r[0].run.conclusion = 'failure')),
    doc
  );
  assert.notEqual(
    tamper((r) => r.pop()),
    doc
  );
});
