'use strict';

/**
 * Balance quality on the fixture: slowest shard and imbalance of native sharding against the
 * engine for two and three shards, one worker per shard, from real harness runs. Both strategies
 * run once with Playwright's per-file units and once with fullyParallel (per-test units). The
 * engine is planned from the history of the native two-shard run, and the native runs carry the
 * same reporter without a timings file, so the reporter costs both sides the same.
 */

function figures(summary) {
  return {
    durationsMs: summary.shards.map((shard) => shard.durationMs),
    leaves: summary.shards.map((shard) => shard.leafCount),
    slowestMs: summary.slowestMs,
    imbalance: summary.imbalance,
    violations: summary.kinds,
  };
}

function change(candidate, native) {
  return (candidate.slowestMs - native.slowestMs) / native.slowestMs;
}

/** One strategy pair: native and engine for the same unit of sharding. */
function pair(ctx, shards, fullyParallel) {
  const suffix = fullyParallel ? '-fp' : '';
  const native = figures(
    (shards === 2 && !fullyParallel
      ? ctx.baseline()
      : ctx.run({ name: `native${shards}${suffix}`, shards, workers: 1, fullyParallel })
    ).summary
  );
  const engine = figures(ctx.balancedRun(shards, { fullyParallel }).summary);
  return { native, engine: { ...engine, slowestVsNative: change(engine, native) } };
}

function balance(ctx) {
  return [2, 3].map((shards) => {
    const files = pair(ctx, shards, false);
    const tests = pair(ctx, shards, true);
    return {
      shards,
      native: files.native,
      engine: files.engine,
      nativeParallel: tests.native,
      engineParallel: tests.engine,
    };
  });
}

module.exports = { balance, figures };
