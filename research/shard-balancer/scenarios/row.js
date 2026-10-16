'use strict';

/**
 * The row format of the research evidence: `{ id, group, claim, status, facts, finding }`.
 * `claim` is the behavior the row tests, `status` says whether the observed behavior matches it
 * (`pass`) or not (`fail`), `facts` holds the observations a test asserts and `finding` is one or
 * two sentences built from the facts.
 */

const GROUPS = {
  a: 'assignment',
  p: 'plan agreement',
  s: 'input safety',
  c: 'check',
  h: 'history',
  e: 'estimates',
  w: 'workers',
  sim: 'simulate',
  i: 'internals',
  n: 'network',
  sa: 'shape A',
  sb: 'shape B',
};

function row(id, claim, matches, facts, finding) {
  const prefix = id.split('.')[0];
  if (!GROUPS[prefix]) throw new Error(`row ${id} has no group`);
  return { id, group: GROUPS[prefix], claim, status: matches ? 'pass' : 'fail', facts, finding };
}

/** The harness facts of a run: whether it passed and its violation counts. */
function harnessFacts(run) {
  return {
    harnessOk: run.summary.ok,
    violations: run.summary.kinds,
    exitCodes: run.raw.map((shard) => shard.exitCode),
  };
}

/** Violation counts as text: `none`, or `duplicate 5, missing 4`. */
function kindsText(kinds) {
  const entries = Object.entries(kinds);
  return entries.length === 0 ? 'none' : entries.map(([kind, n]) => `${kind} ${n}`).join(', ');
}

module.exports = { GROUPS, harnessFacts, kindsText, row };
