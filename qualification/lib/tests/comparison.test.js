/**
 * Tests for the side-by-side tables of docs/qualification/comparison.md, and that the document
 * embeds the tables of the committed reference evidence of both engines.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  renderBalance,
  renderCounts,
  renderDifferences,
  renderFootprint,
  renderResults,
} = require('../comparison');
const { normalizeTable } = require('../tables');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, 'docs', 'qualification', file), 'utf8');
const NSX = JSON.parse(read('nsxbet-evidence.json'));
const FLAKINESS = JSON.parse(read('flakiness-evidence.json'));
const DOC = read('comparison.md');

const figures = (slowest, violations = {}, change) => ({
  durationsMs: [slowest],
  leaves: [10],
  slowestMs: slowest,
  imbalance: 0.05,
  violations,
  ...(change === undefined ? {} : { slowestVsNative: change }),
});

const nsx = {
  proofs: [{ number: 1, title: 'One', status: 'fail' }],
  extras: [{ id: 'x1', title: 'Damaged', status: 'fail' }],
  rows: [
    { id: 'a', status: 'pass' },
    { id: 'b', status: 'fail' },
    { id: 'only-nsx', status: 'fail' },
  ],
  balance: [
    {
      shards: 2,
      native: figures(100),
      engine: figures(110, { 'serial-split': 2 }, 0.1),
      grouped: figures(105, {}, 0.05),
    },
  ],
  footprint: {
    install: { packages: 59, nodeModulesBytes: 9 * 1024 * 1024 },
    runtimeMs: { assignHistory: 154 },
    artifactBytes: { timingArtifact: 1536 },
  },
};
nsx.rows.push(
  { id: 'net.plan-timing', status: 'pass' },
  { id: 'net.mutation-control', status: 'pass' }
);

const flakiness = {
  proofs: [{ number: 1, title: 'One', status: 'pass' }],
  extras: [{ id: 'x1', title: 'Damaged', status: 'pass' }],
  rows: [
    { id: 'a', status: 'pass' },
    { id: 'b', status: 'pass' },
    { id: 'only-flakiness', status: 'fail' },
    { id: 'net.balanced-run', status: 'pass' },
    { id: 'net.mutation-control', status: 'pass' },
  ],
  balance: [
    {
      shards: 2,
      native: figures(100),
      engine: figures(96, {}, -0.04),
      nativeParallel: figures(50),
      engineParallel: figures(51, {}, 0.02),
    },
  ],
  footprint: {
    install: { packages: 1, nodeModulesBytes: 1024 * 1024 },
    playwright: {
      plain: { wallMs: 1000, mainRssKb: 1024 },
      reporter: { wallMs: 1050, mainRssKb: 6144 },
    },
    artifactBytes: { flakinessFolder: 40960 },
  },
};

describe('renderResults', () => {
  test('names the proof the other engine has no result for', () => {
    assert.throws(
      () => renderResults(nsx, { ...flakiness, proofs: [], extras: [] }),
      /no result for 1/
    );
  });

  test('puts the result of each engine next to each proof and extra case', () => {
    assert.strictEqual(
      renderResults(nsx, flakiness),
      [
        '| Proof | What the proof asks | NSXBet | Flakiness |',
        '| --- | --- | --- | --- |',
        '| P1 | One | fail | pass |',
        '| X1 | Damaged | fail | pass |',
      ].join('\n')
    );
  });
});

describe('renderCounts', () => {
  test('counts the engine rows of each proof and case, with the failed ones in brackets', () => {
    const rows = (proof, statuses, subject) =>
      statuses.map((status, index) => ({ id: `${proof}.${index}`, proof, status, subject }));
    const counted = renderCounts(
      {
        proofs: [{ number: 1 }],
        extras: [{ id: 'x1' }],
        rows: [...rows(1, ['pass', 'fail', 'fail']), ...rows('x1', ['fail'])],
      },
      {
        rows: [
          ...rows(1, ['pass']),
          ...rows(1, ['fail'], 'integration'),
          ...rows('x1', ['pass', 'pass']),
        ],
      }
    );
    assert.strictEqual(
      counted,
      [
        '| Proof | NSXBet rows (failed) | Flakiness rows (failed) |',
        '| --- | --- | --- |',
        '| P1 | 3 (2) | 1 (0) |',
        '| X1 | 1 (1) | 2 (0) |',
      ].join('\n')
    );
  });
});

describe('renderDifferences', () => {
  test('lists only the rows both engines have that ended differently', () => {
    assert.strictEqual(
      renderDifferences(nsx, flakiness),
      ['| Row | NSXBet | Flakiness |', '| --- | --- | --- |', '| `b` | fail | pass |'].join('\n')
    );
  });
});

describe('renderBalance', () => {
  const lines = renderBalance(nsx, flakiness).split('\n').slice(2);

  test('gives three NSXBet strategies and three Flakiness strategies per shard count', () => {
    assert.deepStrictEqual(
      lines.map((line) => line.split(' | ').slice(1, 3).join(' / ')),
      [
        'NSXBet / native `--shard`',
        'NSXBet / engine',
        'NSXBet / engine with serial groups kept whole (shim)',
        'Flakiness / native `--shard`',
        'Flakiness / engine',
        'Flakiness / engine, fullyParallel',
      ]
    );
  });

  test('measures each engine against its own native run and lists the violations', () => {
    assert.match(lines[1], /\| \+10\.0% \| 5\.0% \| serial-split 2 \| 100 \|$/);
    assert.match(lines[4], /\| -4\.0% \| 5\.0% \| none \| 100 \|$/);
    assert.match(lines[5], /\| \+2\.0% \| 5\.0% \| none \| 50 \|$/);
  });

  test('refuses a different number of shard counts', () => {
    assert.throws(() => renderBalance(nsx, { ...flakiness, balance: [] }), /other shard counts/);
  });

  test('refuses tables that list other shard counts', () => {
    const other = { ...flakiness, balance: [{ ...flakiness.balance[0], shards: 3 }] };
    assert.throws(() => renderBalance(nsx, other), /other shard counts/);
  });
});

describe('renderFootprint', () => {
  const text = renderFootprint(nsx, flakiness);

  test('shows what each engine adds to a shard run and to the pipeline', () => {
    assert.match(text, /Time added to a shard run \| none \| 50 ms \(\+5\.0%\)/);
    assert.match(text, /Peak memory added to the Playwright process \| none \| 5\.0 MiB/);
    assert.match(text, /Planning step, once per run \| 154 ms/);
  });

  test('shows the audit result with its mutation control', () => {
    assert.match(
      text,
      /Network audit \| pass; mutation control pass \| pass; mutation control pass/
    );
  });
});

describe('the document', () => {
  for (const [name, render] of [
    ['results', renderResults],
    ['counts', renderCounts],
    ['differences', renderDifferences],
    ['balance', renderBalance],
    ['footprint', renderFootprint],
  ]) {
    test(`embeds the ${name} table of the reference evidence`, () => {
      assert.ok(normalizeTable(DOC).includes(normalizeTable(render(NSX, FLAKINESS))));
    });
  }

  test('keeps no placeholder for work left undone', () => {
    assert.doesNotMatch(DOC, /known limitation|follow-up|out of scope|accepted gap|TODO|TBD/i);
  });
});
