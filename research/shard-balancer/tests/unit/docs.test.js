/**
 * Ties docs/research/shard-balancer-harvest.md to the committed evidence and to the decisions. The
 * document must embed every generated table for the committed evidence, the evidence must hold
 * the expected results, every take or adapt must rest on a row that passes, and every row and
 * citation a decision names must be in the evidence as the decision states it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { citationsOf } = require('../../citations');
const { ALL, GAPS, INTERNALS, LISTS, MECHANISMS, WORKFLOW } = require('../../decisions');
const { EXPECTED_ROWS } = require('../../expected');
const report = require('../../report');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOC = fs.readFileSync(
  path.join(ROOT, 'docs', 'research', 'shard-balancer-harvest.md'),
  'utf8'
);
const EVIDENCE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'research', 'shard-balancer-evidence.json'), 'utf8')
);
const rowStatus = new Map(EVIDENCE.rows.map((r) => [r.id, r.status]));

/** The text of one `## ` section of the document. */
function section(title) {
  const start = DOC.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `no section ${title}`);
  const end = DOC.indexOf('\n## ', start + 1);
  return DOC.slice(start, end < 0 ? undefined : end);
}

/** Lines of the document that are prose: no table, heading or code block. */
function prose() {
  let fenced = false;
  return DOC.split('\n').filter((line) => {
    if (line.startsWith('```')) fenced = !fenced;
    return !fenced && !line.startsWith('```') && !line.startsWith('|') && !line.startsWith('#');
  });
}

describe('the document', () => {
  const tables = [
    ['versions', report.renderVersions],
    ['rows', report.renderRows],
    ['gaps', (e) => report.renderDecisions(e, 'gaps')],
    ['workflow', (e) => report.renderDecisions(e, 'workflow')],
    ['mechanisms', (e) => report.renderDecisions(e, 'mechanisms')],
    ['internals', report.renderInternals],
    ['internal runs', report.renderInternalRuns],
    ['couture-cast advice', report.renderCoutureCast],
    ['inputs to S7 and S8', report.renderInputs],
    ['citations', report.renderCitations],
  ];
  for (const [name, render] of tables) {
    test(`embeds the ${name} table of the committed evidence`, () => {
      assert.ok(report.normalizeTable(DOC).includes(report.normalizeTable(render(EVIDENCE))), name);
    });
  }

  test('lists every take and adapt under the inputs to S7 and S8', () => {
    const inputs = section('Inputs to S7 and S8');
    for (const entry of [...GAPS, ...WORKFLOW, ...MECHANISMS].filter(
      (e) => e.decision !== 'reject'
    )) {
      assert.ok(inputs.includes(entry.s8.replaceAll('|', '\\|')), entry.subject);
    }
  });

  test('names the public replacement or the loss of every internal', () => {
    const internals = section('Playwright internals');
    for (const entry of INTERNALS) {
      assert.ok(
        internals.includes(entry.replacement) && internals.includes(entry.loss),
        entry.subject
      );
    }
  });

  test('credits upstream under its MIT license', () => {
    const attribution = section('Attribution');
    assert.match(attribution, /MIT/);
    assert.match(attribution, /Gary Parker/);
    assert.match(attribution, /github\.com\/qa-gary-parker\/playwright-shard-balancer/);
  });

  test('proposes the race-free pin and publish', () => {
    const design = section('Race-free pin and publish');
    assert.match(design, /prepare job/);
    assert.match(design, /`needs:`/);
    assert.match(design, /run number/);
    assert.match(design, /`h\.remerge-union`/);
  });

  test('uses no dash as a clause connector', () => {
    for (const line of prose()) {
      assert.doesNotMatch(line, /—|–| - /, line.slice(0, 80));
    }
  });

  test('keeps no placeholder for work left undone', () => {
    assert.doesNotMatch(DOC, /TODO|TBD|follow-up/i);
  });
});

describe('the committed evidence', () => {
  test('holds exactly the expected rows and results', () => {
    assert.deepStrictEqual(Object.fromEntries(rowStatus), EXPECTED_ROWS);
  });

  test('found every citation of the decisions at its lines', () => {
    const found = new Map(
      EVIDENCE.citations.map((c) => [JSON.stringify([c.source, c.file, c.lines, c.quote]), c])
    );
    for (const c of citationsOf(ALL)) {
      const key = JSON.stringify([c.source, c.file, c.lines, c.quote]);
      assert.ok(found.has(key), `${c.file}:${c.lines} is not in the evidence; collect again`);
      assert.strictEqual(found.get(key).ok, true, `${c.file}:${c.lines}: ${found.get(key).reason}`);
    }
  });

  test('records the package, its published commit and the Playwright of the fixture', () => {
    assert.match(EVIDENCE.versions.package, /^playwright-shard-balancer@\d+\.\d+\.\d+/);
    assert.match(EVIDENCE.versions.commit, /^[0-9a-f]{40}$/);
    assert.match(EVIDENCE.versions.playwright, /^\d+\.\d+\.\d+/);
    assert.match(EVIDENCE.versions.flakiness, /^@flakiness\/playwright@\d+\.\d+\.\d+/);
  });

  test('carries no private path', () => {
    assert.doesNotMatch(
      JSON.stringify(EVIDENCE),
      /\/Users\/|\/home\/(?!runner)|\/var\/folders|\/private\/|psp-psb-|psp-flk-/
    );
  });
});

describe('the decisions', () => {
  for (const [name, list] of Object.entries(LISTS)) {
    for (const entry of list) {
      test(`${name}: ${entry.subject}`, () => {
        assert.ok(['take', 'adapt', 'reject'].includes(entry.decision), entry.decision);
        assert.ok(entry.mechanism && entry.reason && entry.sources.length > 0);
        for (const [id, status] of Object.entries(entry.evidence)) {
          assert.ok(rowStatus.has(id), `${id} is not a row of the evidence`);
          assert.strictEqual(
            rowStatus.get(id),
            status,
            `${id} is ${rowStatus.get(id)} in the evidence`
          );
        }
        if (entry.decision !== 'reject') {
          assert.ok(entry.s8, 'a take or an adapt needs an acceptance test idea');
          assert.ok(
            Object.values(entry.evidence).includes('pass'),
            'a take or an adapt needs a passing row'
          );
        }
        if (name === 'internals') assert.ok(entry.replacement && entry.loss);
      });
    }
  }

  test('cover every gap the qualifications named', () => {
    const named = ['Flakiness P5', 'Flakiness P6', 'Flakiness P7', 'Flakiness P8', 'Flakiness X2'];
    named.push('NSXBet P1', 'NSXBet P2', 'NSXBet P6', 'NSXBet P8', 'NSXBet X1', 'NSXBet X2');
    for (const gap of named)
      assert.ok(
        GAPS.some((e) => e.subject.startsWith(gap)),
        gap
      );
    assert.strictEqual(GAPS.filter((e) => e.subject.startsWith('Flakiness P5')).length, 2);
  });

  test('cover every item of the workflow and history companion', () => {
    const companion = fs.readFileSync(
      path.join(
        ROOT,
        '_bmad-output',
        'initiative-pw-smart-sharding',
        'spec-pw-smart-sharding',
        'workflow-and-history.md'
      ),
      'utf8'
    );
    const items = companion.split('\n').filter((line) => line.startsWith('- '));
    const reuse = companion.includes('gh-build-matrix') ? 1 : 0;
    const deliverables = companion.includes('## Deliverables beyond code') ? 1 : 0;
    assert.strictEqual(WORKFLOW.length, items.length + reuse + deliverables);
  });

  test('cover every mechanism of the brief', () => {
    const brief = [
      'Fail-open, with strict mode once timings exist',
      'One timings copy pinned per workflow run',
      'Median of the last 5 passing samples',
      'New-test estimate from describe, then file, then project, then suite',
      'The `check` exactly-once proof',
      '`simulate` for shard-count advice',
      'Workers-per-shard planning',
      'Lock groups on one shard',
      'The `sleep 20` wait of the cache pin',
    ];
    for (const subject of brief)
      assert.ok(
        MECHANISMS.some((e) => e.subject === subject),
        subject
      );
    assert.deepStrictEqual(
      INTERNALS.map((e) => e.field),
      ['Suite._parallelMode', 'TestCase._locks', 'Suite._parallelMode']
    );
  });
});
