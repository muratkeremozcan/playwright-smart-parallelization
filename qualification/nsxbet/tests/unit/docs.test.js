/**
 * Ties docs/qualification/nsxbet.md to the evidence. The document must state the verdict, give
 * every proof and every row the result the tests expect, and embed the generated tables for the
 * committed reference evidence, which must itself hold the expected results.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EXPECTED_EXTRAS, EXPECTED_PROOFS, EXPECTED_ROWS, VERDICT } = require('../../expected');
const { summarizeExtras, summarizeProofs } = require('../../proofs');
const { normalizeTable, renderBalance, renderFootprint, renderVersions } = require('../../report');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'qualification', 'nsxbet.md'), 'utf8');
const EVIDENCE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'qualification', 'nsxbet-evidence.json'), 'utf8')
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
      /\/Users\/|\/home\/(?!runner)|\/var\/folders|psp-nsx/
    );
  });
});
