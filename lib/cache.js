'use strict';

/**
 * The Actions cache as the Action uses it: `restore(dir, key, restoreKeys)` returns the key it
 * matched or '', `save(dir, key)` returns whether this call created the entry, and `available()`
 * says whether the runner has a cache service at all. `dir` is relative to the workspace, which is
 * the process's working directory, so every shard computes one cache version for it.
 *
 * `toolkitCache` wraps `@actions/cache`. A save onto a key that exists is the normal way a
 * compare-and-swap loses, so the toolkit's warning about it is logged as a plain line instead of
 * a warning annotation on every shard. A write the cache service refuses by policy is remembered
 * in `writeDenied`, because then no shard of the run can pin or publish.
 */

const RESERVATION = /^::warning::Cache reservation failed: /;
const DENIED = /cache write denied/i;

/** Runs `fn` with the lines it writes to stdout passed through `filter`. */
async function filtered(filter, fn) {
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    const text = String(chunk);
    const kept = text
      .split(/(?<=\n)/)
      .map(filter)
      .join('');
    return write.call(process.stdout, kept, ...rest);
  };
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

function toolkitCache(cache) {
  const adapter = {
    writeDenied: false,
    available: () => cache.isFeatureAvailable(),
    async restore(dir, key, restoreKeys = []) {
      return (await cache.restoreCache([dir], key, restoreKeys)) || '';
    },
    async save(dir, key) {
      const id = await filtered(
        (line) => {
          if (DENIED.test(line)) adapter.writeDenied = true;
          return RESERVATION.test(line) ? line.replace('::warning::', '') : line;
        },
        () => cache.saveCache([dir], key)
      );
      return id !== -1;
    },
  };
  return adapter;
}

module.exports = { toolkitCache };
