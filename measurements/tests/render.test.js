'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../render');
const { makeRecord, makeTest, standard } = require('./support');

const lean = { queue: 1000, setup: 1000, prepare: 0, server: 0, after: 0 };

function labelled(label, id, start, overrides = {}) {
  return standard({ label, id, start, pair: ((id - 1) % 3) + 1, ...overrides });
}

function dataset() {
  return [
    labelled('a', 1, 0),
    labelled('a', 2, 10 * 60000, { mergeMs: 70000 }),
    labelled('a', 3, 20 * 60000, { mergeMs: 80000 }),
    labelled('b', 4, 5000),
    labelled('b', 5, 10 * 60000 - 5000, { mergeMs: 65000 }),
    labelled('b', 6, 20 * 60000 + 5000, { mergeMs: 75000 }),
  ];
}

test('renders every section with figures that come from the records', () => {
  const doc = render(dataset());
  for (const heading of [
    '## Shape under test',
    '## Runs',
    '### Pass rate',
    '## Medians and spread',
    '## Where the time goes',
    '### Dominant delay',
    '## Balance and headroom',
    '## Upgrade control',
    '## Method',
  ]) {
    assert.ok(doc.includes(heading), heading);
  }
  assert.match(
    doc,
    /\| Completion \(created to last job done\) \| a \| 267\.0 s \| 257\.0 s \| 277\.0 s \| 7\.5% \|/
  );
  assert.match(doc, /the dominant delay is \*\*fixed setup cost\*\*/);
  assert.match(doc, /\| a \| 3 \| 3 \| 100\.0% \| 3 \| 3 \| none \|/);
  assert.match(
    doc,
    /The fixed cost ranged over 20\.0 s between runs, against a median balance headroom of 0\.0 s\./
  );
});

test('records which label of a pair was dispatched first', () => {
  const doc = render(dataset());
  const rows = doc
    .split('\n')
    .filter((line) => /^\| [ab] \| \d \|/.test(line) && line.includes('example.test'));
  const order = (label, pair) =>
    rows
      .find((l) => l.startsWith(`| ${label} | ${pair} |`))
      .split('|')[5]
      .trim();
  assert.deepEqual([order('a', 1), order('b', 1)], ['first', 'second']);
  assert.deepEqual([order('a', 2), order('b', 2)], ['second', 'first']);
  assert.deepEqual([order('a', 3), order('b', 3)], ['first', 'second']);
});

test('a failed run lowers the pass rate and a cancelled run is listed as excluded', () => {
  const data = dataset();
  data[1].run.conclusion = 'failure';
  data[2].run.conclusion = 'cancelled';
  data[2].shards[1].blob = null;
  data[2].shards[1].blobMissing = 'no blob artifact was uploaded';
  const doc = render(data);
  assert.match(
    doc,
    /\| a \| 3 \| 1 \| 33\.3% \| 2 \| 2 \| 3: shard 2: no blob artifact was uploaded \|/
  );
  assert.match(doc, /shard 2: no blob artifact was uploaded \|$/m);
});

test('changing a raw figure changes the document, and an inconsistent record is refused', () => {
  const base = render(dataset());
  const slower = dataset();
  slower[0].shards[1].blob.tests[0].attempts[0].duration += 5000;
  assert.notEqual(render(slower), base);
  const fewer = dataset().slice(1);
  assert.notEqual(render(fewer), base);
  const mismatched = dataset();
  mismatched[0].shards[0].blob.shard.current = 2;
  assert.throws(() => render(mismatched), /is shard 2/);
  assert.throws(() => render([]), /no raw records/);
});

test('a label whose runs all lack timings is an error, never a blank row', () => {
  const data = dataset();
  for (const record of data.filter((r) => r.label === 'b')) {
    record.shards[0].blob = null;
    record.shards[0].blobMissing = 'the blob artifact expired';
  }
  assert.throws(() => render(data), /no run with timings/);
});

test('a single label renders without an upgrade comparison', () => {
  const doc = render(dataset().filter((r) => r.label === 'a'));
  assert.match(doc, /no upgrade comparison/);
});

test('the dominant delay follows the data: an oversized serial group changes the verdict', () => {
  const big = [1, 2, 3].map((id) => {
    const record = makeRecord({
      id,
      pair: id,
      label: 'a',
      serialSuites: [{ file: 's.spec.ts', suite: 'S' }],
      shards: [
        {
          ...lean,
          tests: [makeTest('s', [600000], { file: 's.spec.ts', titlePath: ['s.spec.ts', 'S'] })],
        },
        { ...lean, tests: [makeTest('z', [10000])] },
      ],
    });
    return record;
  });
  assert.match(render(big), /the dominant delay is \*\*one oversized atomic group\*\*/);
});

test('the step table lists steps of a second or more and leaves shorter ones out', () => {
  const data = dataset();
  for (const record of data) {
    for (const job of record.jobs.filter((j) => j.name.startsWith('pw-e2e'))) {
      const at = Date.parse(job.startedAt);
      const extra = (number, name, ms) => ({
        number,
        name,
        status: 'completed',
        conclusion: 'success',
        startedAt: new Date(at).toISOString(),
        completedAt: new Date(at + ms).toISOString(),
      });
      job.steps.push(extra(8, 'Edge step', 1000), extra(9, 'Tiny step', 900));
    }
  }
  const doc = render(data);
  assert.match(doc, /\| pw-e2e \| Edge step \| 1\.0 s \| 1\.0 s \|/);
  assert.equal(doc.includes('Tiny step'), false);
});

test('records of different targets, a reused run or a second run in one pair are refused', () => {
  const different = dataset();
  different[3].repo = { owner: 'o', name: 'other' };
  assert.throws(() => render(different), /measures a different target/);
  const reused = dataset();
  reused[1].run.id = reused[0].run.id;
  assert.throws(() => render(reused), /appears in two records/);
  const crowded = dataset();
  crowded[1].pair = 1;
  assert.throws(() => render(crowded), /two runs in one pair/);
});

test('the upgrade control refuses a third label and a changing shard count', () => {
  const three = [...dataset(), labelled('c', 7, 30 * 60000)];
  assert.throws(() => render(three), /exactly two labels/);
  const wider = makeRecord({
    id: 8,
    label: 'a',
    pair: 4,
    start: 40 * 60000,
    shards: [1, 2, 3].map((n) => ({ ...lean, tests: [makeTest(`w${n}`, [1000])] })),
  });
  assert.throws(() => render([...dataset(), wider]), /shard count differs/);
});

test('what each label is and the serial suite count come from the records', () => {
  const data = dataset();
  data[0].labelNote = 'plain main';
  data[0].serialSuites = [];
  for (const r of data) r.serialSuites = [];
  const doc = render(data);
  assert.match(doc, /What `a` is \| plain main/);
  assert.match(doc, /0 of its suites are serial/);
});

test('the pass-rate table counts timed runs whose tests all passed apart from timed runs', () => {
  const data = dataset();
  data[0].shards[0].blob.tests[0].attempts.forEach((a) => (a.status = 'failed'));
  const doc = render(data);
  assert.match(doc, /\| a \| 3 \| 3 \| 100\.0% \| 3 \| 2 \| none \|/);
});
