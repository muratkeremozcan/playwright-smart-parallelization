/**
 * Ties docs/research/shard-balancer-harvest.md to the committed evidence and to the decisions. Every
 * generated block of the document must equal its rendering from the committed evidence, the
 * evidence must hold the expected results and facts, every take or adapt must rest on a row that
 * passes, and every row and citation a decision names must be in the evidence as the decision
 * states it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ALL, GAPS, INTERNALS, LISTS, MECHANISMS, WORKFLOW } = require('../../decisions');
const { EXPECTED_FACTS, EXPECTED_ROWS, factAt } = require('../../expected');
const report = require('../../report');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOC = fs.readFileSync(
  path.join(ROOT, 'docs', 'research', 'shard-balancer-harvest.md'),
  'utf8'
);
const DEVELOPMENT = fs.readFileSync(path.join(ROOT, 'docs', 'development.md'), 'utf8');
const EVIDENCE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'research', 'shard-balancer-evidence.json'), 'utf8')
);
const rowStatus = new Map(EVIDENCE.rows.map((r) => [r.id, r.status]));
const BLOCKS = report.blocksOf(DOC);

/** The text of one `## ` section of a markdown text. */
function section(title, text = DOC) {
  const start = text.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `no section ${title}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The document with every generated block cut out: the text typed by hand. */
const HAND = DOC.replace(/<!-- generated:([a-z-]+) -->[\s\S]*?<!-- \/generated:\1 -->/g, '');

/** Lines of a text outside code blocks, headings and comments, with code spans removed. */
function proseLines(text) {
  let fenced = false;
  return text
    .split('\n')
    .filter((line) => {
      if (line.startsWith('```')) fenced = !fenced;
      return (
        !fenced && !line.startsWith('```') && !line.startsWith('#') && !line.startsWith('<!--')
      );
    })
    .map((line) => line.replace(/`[^`]*`/g, '``'));
}

/** Every sentence-bearing text the decisions and the evidence put into the document. */
function generatedTexts() {
  const texts = [];
  for (const entry of ALL) {
    for (const key of ['subject', 'mechanism', 'reason', 's8', 'replacement', 'loss']) {
      if (entry[key]) texts.push(entry[key]);
    }
  }
  for (const r of EVIDENCE.rows) texts.push(r.claim, r.finding);
  return texts.map((text) => text.replace(/`[^`]*`/g, '``'));
}

const DEVELOPMENT_SECTION = section('Research', DEVELOPMENT);
const ANTITHESIS = /instead of|rather than|\bnot\b[^.;:]*\bbut\b|, not /i;
const DASH = /—|–| - /;

describe('the document', () => {
  for (const [name, render] of Object.entries(report.BLOCKS)) {
    test(`holds the ${name} block exactly as rendered from the committed evidence`, () => {
      assert.ok(name in BLOCKS, `no block ${name}`);
      assert.strictEqual(
        report.normalizeTable(BLOCKS[name]),
        report.normalizeTable(render(EVIDENCE).trim())
      );
    });
  }

  test('holds no block without a renderer', () => {
    assert.deepStrictEqual(Object.keys(BLOCKS).sort(), Object.keys(report.BLOCKS).sort());
  });

  test('is what the report command writes', () => {
    const normalize = (blocks) =>
      Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, report.normalizeTable(v)]));
    assert.deepStrictEqual(
      normalize(report.blocksOf(report.renderDocument(DOC, EVIDENCE))),
      normalize(BLOCKS)
    );
  });

  test('names the public replacement and the loss of every internal', () => {
    const internals = section('Playwright internals');
    for (const entry of INTERNALS) {
      assert.ok(
        internals.includes(entry.replacement) && internals.includes(entry.loss),
        entry.subject
      );
    }
  });

  test('says exactly what is copied from upstream, under its MIT notice', () => {
    const attribution = section('Attribution');
    assert.match(attribution, /Gary Parker/);
    assert.match(attribution, /github\.com\/qa-gary-parker\/playwright-shard-balancer/);
    assert.match(attribution, /`research\/shard-balancer\/lib\/median\.js`/);
    assert.match(attribution, /`src\/timings\.ts:89-93`/);
    const copied = fs.readFileSync(
      path.join(ROOT, 'research', 'shard-balancer', 'lib', 'median.js'),
      'utf8'
    );
    assert.ok(copied.includes(EVIDENCE.versions.license), 'the copied file carries the notice');
    assert.match(copied, /Permission is hereby granted, free of charge/);
  });

  test('proposes the race-free pin and publish', () => {
    const design = section('Race-free pin and publish');
    for (const needed of [
      /prepare job/,
      /`needs:`/,
      /REST API/,
      /compare-and-swap/,
      /run number/,
      /`h\.remerge-union`/,
    ]) {
      assert.match(design, needed);
    }
  });

  test('takes every number of the text typed by hand from the evidence or the decisions', () => {
    const known = new Set(
      `${JSON.stringify(EVIDENCE)} ${JSON.stringify(ALL)}`.match(/\d+(?:\.\d+)?/g)
    );
    for (const line of proseLines(HAND.replace(/`([^`]*)`/g, '$1'))) {
      const stripped = line.replace(/\b(?:S|P|X|CAP-)\d+\b/g, '');
      for (const number of stripped.match(/\d+(?:\.\d+)?/g) || []) {
        assert.ok(known.has(number), `${number} in: ${line.slice(0, 100)}`);
      }
    }
  });

  test('uses no dash as a clause connector, in the prose, the tables, the development guide section or the generated text', () => {
    for (const line of [
      ...proseLines(DOC),
      ...proseLines(DEVELOPMENT_SECTION),
      ...generatedTexts(),
    ]) {
      assert.doesNotMatch(line.replace(/^- /, ''), DASH, line.slice(0, 100));
    }
  });

  test('uses no negation set up only to be corrected', () => {
    for (const line of [
      ...proseLines(DOC),
      ...proseLines(DEVELOPMENT_SECTION),
      ...generatedTexts(),
    ]) {
      assert.doesNotMatch(line, ANTITHESIS, line.slice(0, 100));
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

  for (const [id, facts] of Object.entries(EXPECTED_FACTS)) {
    test(`holds the expected facts of ${id}`, () => {
      const found = EVIDENCE.rows.find((r) => r.id === id);
      for (const [dotted, value] of Object.entries(facts)) {
        assert.deepStrictEqual(factAt(found.facts, dotted), value, `${id}: ${dotted}`);
      }
    });
  }

  test('found every source of every decision at its lines', () => {
    const found = new Map(
      EVIDENCE.citations.map((c) => [JSON.stringify([c.source, c.file, c.lines, c.quote]), c])
    );
    for (const entry of ALL) {
      for (const s of [...entry.sources, ...(entry.readAt ? [entry.readAt] : [])]) {
        const key = JSON.stringify([s.source || 'upstream', s.file, s.lines, s.quote]);
        assert.ok(found.has(key), `${entry.subject}: ${s.file}:${s.lines} is not in the evidence`);
        assert.strictEqual(
          found.get(key).ok,
          true,
          `${s.file}:${s.lines}: ${found.get(key).reason}`
        );
      }
    }
  });

  test('records the package, its published commit, its license and the Playwright of the fixture', () => {
    assert.match(EVIDENCE.versions.package, /^playwright-shard-balancer@\d+\.\d+\.\d+/);
    assert.match(EVIDENCE.versions.commit, /^[0-9a-f]{40}$/);
    assert.match(EVIDENCE.versions.license, /^Copyright \(c\) \d{4} /);
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
        if (name === 'internals') {
          assert.ok(entry.replacement && entry.loss && entry.readAt);
          assert.ok(entry.sources.includes(entry.readAt), 'the read itself is a cited source');
        }
      });
    }
  }

  test('list every entry with an acceptance test under the inputs to S7 and S8', () => {
    const inputs = BLOCKS.inputs;
    for (const entry of ALL.filter((e) => e.s8)) {
      assert.ok(inputs.includes(entry.s8.replaceAll('|', '\\|')), entry.subject);
    }
    for (const entry of INTERNALS)
      assert.ok(entry.decision === 'reject' || entry.s8, entry.subject);
  });

  test('say for every take and adapt mechanism whether it works under each shape, with a row', () => {
    const { SHAPES } = require('../../decisions');
    for (const entry of MECHANISMS.filter((e) => e.decision !== 'reject')) {
      assert.ok(entry.shapes, `${entry.subject} has no shapes`);
      for (const shape of ['a', 'b']) {
        const s = entry.shapes[shape];
        assert.ok(s && typeof s.works === 'boolean' && s.s8, `${entry.subject}: shape ${shape}`);
        assert.ok(rowStatus.has(s.row), `${entry.subject}: ${s.row} is not a row`);
        if (s.works) assert.strictEqual(rowStatus.get(s.row), 'pass', `${entry.subject}: ${s.row}`);
      }
    }
    for (const subject of Object.keys(SHAPES)) {
      assert.ok(
        MECHANISMS.some((e) => e.subject === subject),
        `no mechanism ${subject}`
      );
    }
  });

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

  test('answer each item of the workflow and history companion once', () => {
    // The harvest answered the companion as it stood then (commit e0f8039); the companion has
    // since moved on to the loop that was built, so the test reads the copy of that version.
    const companion = fs.readFileSync(
      path.join(__dirname, 'workflow-and-history-at-harvest.md'),
      'utf8'
    );
    const items = companion
      .split('\n')
      .filter((line) => line.startsWith('- ') || /gh-build-matrix|^Documentation of/.test(line));
    assert.strictEqual(items.length, WORKFLOW.length);
    for (const line of items) {
      const matches = WORKFLOW.filter((entry) => line.includes(entry.item));
      assert.strictEqual(matches.length, 1, line);
    }
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
