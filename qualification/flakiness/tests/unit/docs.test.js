/**
 * Ties docs/qualification/flakiness.md to the evidence. The document must state the verdict, give
 * every proof and every row the result the tests expect, and embed the generated tables for the
 * committed reference evidence, which must itself hold the expected results.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EXPECTED_EXTRAS, EXPECTED_PROOFS, EXPECTED_ROWS, VERDICT } = require('../../expected');
const { PROOFS, summarizeExtras, summarizeProofs } = require('../../proofs');
const { normalizeTable, renderBalance, renderFootprint, renderVersions } = require('../../report');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'qualification', 'flakiness.md'), 'utf8');
const EVIDENCE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'qualification', 'flakiness-evidence.json'), 'utf8')
);

/** Cells of the table rows whose first cell matches `first`. */
function tableRows(first) {
  return DOC.split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .filter((cells) => first.test(cells[0]));
}

/** Digit runs in a text outside code spans, proof, case and shard references and file names. */
function numbersIn(text) {
  const stripped = text
    .replace(/`[^`]*`/g, '')
    .replace(/\b(?:proofs?|cases?|shards?|P|X)\s?\d+(?:(?:,| and| to) \d+)*/gi, '')
    .replace(/\([^)]*\)/g, (group) => (/\d/.test(group) ? group : ''));
  return [...stripped.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
}

// Numbers the document states about the package, which no run of the fixture produces: the
// Playwright release the balanced mode needs.
const FACTS = new Set(['1.62', '1', '62']);

/** Lines of the document that are prose: no table, heading or code block. */
function proseOutsideTables() {
  let fenced = false;
  return DOC.split('\n').filter((line) => {
    if (line.startsWith('```')) fenced = !fenced;
    return !fenced && !line.startsWith('```') && !line.startsWith('|') && !line.startsWith('#');
  });
}

describe('the document', () => {
  test('states the expected verdict on its own line', () => {
    const verdicts = DOC.match(/^Verdict: .*$/gm);
    assert.deepStrictEqual(verdicts, [`Verdict: ${VERDICT}.`]);
  });

  test('gives every proof its expected result', () => {
    const rows = tableRows(/^P[1-8]$/);
    assert.deepStrictEqual(
      Object.fromEntries(rows.map((cells) => [cells[0].slice(1), cells[1]])),
      Object.fromEntries(Object.entries(EXPECTED_PROOFS))
    );
  });

  test('gives every extra case its expected result', () => {
    const rows = tableRows(/^X[12]$/);
    assert.deepStrictEqual(
      Object.fromEntries(rows.map((cells) => [cells[0].toLowerCase(), cells[1]])),
      EXPECTED_EXTRAS
    );
  });

  test('gives every row its expected result, once', () => {
    const rows = tableRows(/^`[^`]+`$/);
    const found = rows.map((cells) => [cells[0].replaceAll('`', ''), cells[1]]);
    assert.deepStrictEqual(
      found.sort(([a], [b]) => a.localeCompare(b)),
      Object.entries(EXPECTED_ROWS).sort(([a], [b]) => a.localeCompare(b))
    );
  });

  for (const [name, render] of [
    ['versions', renderVersions],
    ['balance', renderBalance],
    ['footprint', renderFootprint],
  ]) {
    test(`embeds the ${name} table of the reference evidence`, () => {
      assert.ok(normalizeTable(DOC).includes(normalizeTable(render(EVIDENCE))));
    });
  }

  test('gives every proof the question the proofs ask', () => {
    const rows = tableRows(/^P[1-8]$/);
    assert.deepStrictEqual(
      rows.map((cells) => cells[2]),
      PROOFS.map((proof) => `${proof.title}.`)
    );
  });

  test('takes every number in the finding of a row from the evidence of that row', () => {
    for (const cells of tableRows(/^`[^`]+`$/)) {
      const id = cells[0].replaceAll('`', '');
      const row = EVIDENCE.rows.find((candidate) => candidate.id === id);
      const known = new Set(numbersIn(`${row.title} ${JSON.stringify(row.evidence)}`));
      for (const number of numbersIn(cells[2])) {
        assert.ok(known.has(number), `${id}: ${number} is not in the evidence`);
      }
    }
  });

  test('takes every number in the prose from the evidence or from the package versions', () => {
    const known = new Set(numbersIn(JSON.stringify(EVIDENCE)));
    for (const sentence of proseOutsideTables()) {
      for (const number of numbersIn(sentence)) {
        assert.ok(known.has(number) || FACTS.has(number), `${number} in: ${sentence}`);
      }
    }
  });

  test('keeps no placeholder for work left undone', () => {
    assert.doesNotMatch(DOC, /known limitation|follow-up|out of scope|accepted gap|TODO|TBD/i);
  });
});

describe('the reference evidence', () => {
  test('holds exactly the expected rows and results', () => {
    const actual = Object.fromEntries(EVIDENCE.rows.map((row) => [row.id, row.status]));
    assert.deepStrictEqual(actual, EXPECTED_ROWS);
  });

  test('rolls up to the expected extra cases', () => {
    const actual = Object.fromEntries(summarizeExtras(EVIDENCE.rows).map((e) => [e.id, e.status]));
    assert.deepStrictEqual(actual, EXPECTED_EXTRAS);
  });

  test('rolls up to the expected proofs', () => {
    const actual = Object.fromEntries(
      summarizeProofs(EVIDENCE.rows).map((p) => [p.number, p.status])
    );
    assert.deepStrictEqual(actual, EXPECTED_PROOFS);
  });

  test('carries no private path', () => {
    assert.doesNotMatch(
      JSON.stringify(EVIDENCE),
      /\/Users\/|\/home\/(?!runner)|\/var\/folders|psp-flk/
    );
  });
});
