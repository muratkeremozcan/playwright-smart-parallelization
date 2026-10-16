/**
 * Asserts every row and every citation against fresh evidence. The evidence comes from
 * `PSP_PSB_EVIDENCE` (a file written by `npm run research:shard-balancer`) or, when that is unset,
 * from a collection run by this file, which takes about half an hour.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { citationsOf } = require('../citations');
const { collectEvidence } = require('../collect');
const { ALL } = require('../decisions');
const { EXPECTED_FACTS, EXPECTED_ROWS, factAt } = require('../expected');

let evidence;

before(async () => {
  evidence = process.env.PSP_PSB_EVIDENCE
    ? JSON.parse(fs.readFileSync(process.env.PSP_PSB_EVIDENCE, 'utf8'))
    : await collectEvidence({ log: (line) => process.stderr.write(`${line}\n`) });
});

const rowOf = (id) => {
  const found = evidence.rows.find((candidate) => candidate.id === id);
  assert.ok(found, `no row ${id}`);
  return found;
};

describe('rows', () => {
  test('the evidence has exactly the expected rows', () => {
    assert.deepStrictEqual(
      evidence.rows.map((r) => r.id).sort(),
      Object.keys(EXPECTED_ROWS).sort()
    );
  });

  for (const [id, expected] of Object.entries(EXPECTED_ROWS)) {
    test(`${id} is ${expected}`, () => {
      const found = rowOf(id);
      assert.strictEqual(found.status, expected, `${id}: ${found.finding}`);
      for (const [dotted, value] of Object.entries(EXPECTED_FACTS[id] || {})) {
        assert.deepStrictEqual(factAt(found.facts, dotted), value, `${id}: ${dotted}`);
      }
    });
  }

  test('every row has a claim, a finding and facts', () => {
    for (const r of evidence.rows) {
      assert.ok(r.claim && r.finding && r.facts && r.group, r.id);
    }
  });
});

describe('citations', () => {
  test('every citation of the decisions was checked', () => {
    const checked = new Set(
      evidence.citations.map((c) => JSON.stringify([c.source, c.file, c.lines, c.quote]))
    );
    for (const c of citationsOf(ALL)) {
      assert.ok(
        checked.has(JSON.stringify([c.source, c.file, c.lines, c.quote])),
        `${c.file}:${c.lines}`
      );
    }
  });

  test('every quote is found at its lines', () => {
    for (const c of evidence.citations) {
      assert.strictEqual(c.ok, true, `${c.source} ${c.file}:${c.lines}: ${c.reason} (${c.quote})`);
    }
  });
});

describe('versions', () => {
  test('name the resolved package, its published commit and the Playwright of the fixture', () => {
    assert.match(evidence.versions.package, /^playwright-shard-balancer@\d+\.\d+\.\d+/);
    assert.match(evidence.versions.commit, /^[0-9a-f]{40}$/);
    assert.match(evidence.versions.playwright, /^\d+\.\d+\.\d+/);
    assert.match(evidence.versions.flakiness, /^@flakiness\/playwright@\d+\.\d+\.\d+/);
  });

  test('the evidence carries no private path', () => {
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /\/Users\/|\/home\/(?!runner)|\/var\/folders|\/private\/|psp-psb-|psp-flk-/
    );
  });
});
