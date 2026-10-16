'use strict';

/**
 * How the runs of one arm and its control form pairs. The dispatcher uses it to know which pair to
 * run next, and the renderer uses it to know which pairs it may compare, so both read pairs alike.
 *
 * A pair is `matched` when both halves have timings and were created at most `MAX_GAP_MS` apart,
 * `stale` when both have timings but further apart, `broken` when a half stopped inside its test
 * step (that run belongs to the shape under test and is never replaced), and `open` otherwise.
 */

const MAX_GAP_MS = 60 * 60_000;

/** The pairs of `arm` by pair number, from analyzed runs that carry their `comparison`. */
function pairStates(runs, control, arm) {
  const states = new Map();
  for (const run of runs) {
    if (run.comparison !== arm || (run.label !== control && run.label !== arm)) continue;
    if (!states.has(run.pair)) states.set(run.pair, { pair: run.pair, control: [], arm: [] });
    states.get(run.pair)[run.label === control ? 'control' : 'arm'].push(run);
  }
  return [...states.values()].sort((a, b) => a.pair - b.pair).map(classify);
}

function classify(state) {
  const timed = (list) => list.filter((run) => !run.excluded);
  const c = timed(state.control);
  const a = timed(state.arm);
  if (c.length > 1 || a.length > 1) {
    throw new Error(`pair ${state.pair} has two timed runs on one side`);
  }
  const all = [...state.control, ...state.arm];
  if (c.length === 1 && a.length === 1) {
    const gapMs = Math.abs(c[0].createdAt - a[0].createdAt);
    return {
      ...state,
      status: gapMs <= MAX_GAP_MS ? 'matched' : 'stale',
      gapMs,
      controlRun: c[0],
      armRun: a[0],
    };
  }
  if (all.some((run) => run.excluded && run.cause === 'in-tests')) {
    return { ...state, status: 'broken' };
  }
  return { ...state, status: 'open' };
}

module.exports = { MAX_GAP_MS, pairStates };
