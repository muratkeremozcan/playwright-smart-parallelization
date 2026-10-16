'use strict';

/**
 * The fixture variants of `qualification/lib/variants.js` plus the failing run through the engine,
 * which depends on how the engine plans.
 */

const variants = require('../lib/variants');

const { greenProject, redProject } = variants;

const VOLATILE_ID = 'volatile.spec.js::volatile step';

/**
 * The failing variant run through the engine, with the green variant's native run as its history.
 * The run keeps JSON and blob reports and a separate output directory per shard.
 */
function redRun(ctx) {
  const cwd = redProject(ctx);
  const green = ctx.baseline({ name: 'volatile-green', cwd: greenProject(ctx) });
  const red = ctx.engineRun({
    name: 'volatile-red',
    cwd,
    flow: 'merged',
    shards: 2,
    timing: green.history.timing,
    reports: { blob: true, output: true },
  });
  return { cwd, green, red };
}

module.exports = {
  VOLATILE_ID,
  ...variants,
  redRun,
};
