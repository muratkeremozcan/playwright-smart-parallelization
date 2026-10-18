'use strict';

/**
 * Preload that makes every `Date.now()` call report one more second than the last. A process
 * under it behaves like one on a runner so slow that any time budget is spent at once.
 */

const real = Date.now;
let ticks = 0;
Date.now = () => real() + 1000 * ticks++;
