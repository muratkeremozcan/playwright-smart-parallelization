'use strict';

/**
 * The shape of the evidence both engine qualifications write: the eight compatibility proofs, the
 * extra cases, the roll-up of rows into proof results, and the merge of the evidence of separate
 * groups. A row is `{ id, proof, title, status, subject, evidence }`. `status` is `pass`, `fail`
 * (a reproduced failure) or `skipped`. `subject` is `engine`, `integration` for a row that
 * measures glue code around the engine, or `playwright` for a row that shows Playwright's own
 * behavior. Only engine rows decide a proof. `proof` is a number 1 to 8, or an extra case (`x1`,
 * `x2`).
 */

const PROOFS = [
  { number: 1, title: 'Every selected leaf runs in exactly one shard' },
  { number: 2, title: 'Serial groups and setup or teardown dependencies keep their behavior' },
  { number: 3, title: 'Filters and project selection mean the same as before' },
  { number: 4, title: 'Every shard uses one assignment' },
  { number: 5, title: 'Corrupt or mismatched input cannot split shards' },
  { number: 6, title: 'Exit codes, retries, traces and reports stay valid' },
  { number: 7, title: 'A run with no history is complete, new tests are kept' },
  {
    number: 8,
    title: 'Failed or cancelled runs and a damaged history file never replace good history',
  },
];

/** Cases the proofs do not cover: each has rows, and a result like a proof. */
const EXTRAS = [
  { id: 'x1', title: 'One shard with a damaged timing file' },
  { id: 'x2', title: 'Two runs racing to publish history' },
];

/** The proof's result: `fail` when any engine row of that proof failed. */
function proofStatus(rows, number) {
  const own = rows.filter((row) => row.proof === number && (row.subject || 'engine') === 'engine');
  return own.some((row) => row.status === 'fail') ? 'fail' : 'pass';
}

/** `{ id, title, status }` for each extra case. */
function summarizeExtras(rows) {
  return EXTRAS.map((extra) => ({ ...extra, status: proofStatus(rows, extra.id) }));
}

/** `{ number, title, status }` for each proof. */
function summarizeProofs(rows) {
  return PROOFS.map((proof) => ({ ...proof, status: proofStatus(rows, proof.number) }));
}

/**
 * Joins the evidence of separate groups into one: rows are concatenated, balance and footprint
 * come from the group that measured them, and the proofs are rolled up again. Throws on a
 * repeated row, on different versions or when two groups hold the same measurement.
 */
function mergeEvidence(parts) {
  if (parts.length === 0) throw new Error('nothing to merge');
  const [first] = parts;
  const ids = new Set();
  for (const part of parts) {
    if (JSON.stringify(part.versions) !== JSON.stringify(first.versions)) {
      throw new Error('the parts were collected with different versions');
    }
    for (const row of part.rows) {
      if (ids.has(row.id)) throw new Error(`row ${row.id} appears in two parts`);
      ids.add(row.id);
    }
  }
  const only = (key) => {
    const found = parts.map((part) => part[key]).filter(Boolean);
    if (found.length > 1) throw new Error(`${key} appears in two parts`);
    return found[0] || null;
  };
  const rows = parts.flatMap((part) => part.rows);
  return {
    generatedAt: new Date().toISOString(),
    group: 'all',
    versions: first.versions,
    rows,
    proofs: summarizeProofs(rows),
    extras: summarizeExtras(rows),
    balance: only('balance'),
    footprint: only('footprint'),
    durationMs: Math.max(...parts.map((part) => part.durationMs)),
    legsMs: Object.fromEntries(parts.map((part) => [part.group, part.durationMs])),
  };
}

module.exports = {
  EXTRAS,
  PROOFS,
  mergeEvidence,
  proofStatus,
  summarizeExtras,
  summarizeProofs,
};
