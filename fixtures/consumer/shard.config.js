'use strict';

const base = require('./playwright.config.js');

// The same projects with sharding set in the config. The harness partitions the run itself, so a
// config that shards is outside its contract.
module.exports = { ...base, shard: { current: 1, total: 2 } };
