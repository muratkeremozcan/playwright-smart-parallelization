'use strict';

/**
 * Balance quality on the fixture: slowest shard and imbalance of native sharding against the
 * engine for two and three shards, one worker per shard, from real harness runs. The engine is
 * planned from the history of the native two-shard run, with and without the serial-group shim.
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

function balance(ctx) {
  return [2, 3].map((shards) => {
    const native = figures(
      (shards === 2 ? ctx.baseline() : ctx.baseline({ name: 'native3', shards })).summary
    );
    const run = (flow) => figures(ctx.engineHistoryRun(shards, flow).summary);
    const engine = run('merged');
    const grouped = run('grouped');
    return {
      shards,
      native,
      engine: { ...engine, slowestVsNative: change(engine, native) },
      grouped: { ...grouped, slowestVsNative: change(grouped, native) },
    };
  });
}

module.exports = { balance, figures };
