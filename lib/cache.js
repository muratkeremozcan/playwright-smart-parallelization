'use strict';

/**
 * The Actions cache as the Action uses it: `restore(dir, key, restoreKeys)` returns the key it
 * matched or '', `lookup(dir, key, restoreKeys)` the key a restore would match without
 * downloading it, `save(dir, key)` returns whether this call created the entry, `available()` says
 * whether the runner has a cache service at all, and `readable()` and `writable()` follow the
 * cache mode the runner sets for the job (`ACTIONS_CACHE_MODE`: none, read, write or write-only;
 * unset or unknown allows both, as the toolkit does). `dir` is relative to the workspace, which is
 * the process's working directory, so every shard computes one cache version for it.
 *
 * `toolkitCache` wraps `@actions/cache`. A save onto a key that exists is the normal way a
 * compare-and-swap loses, so the toolkit's warnings about it are logged as plain lines instead of
 * a warning annotation on every shard. A write the cache service refuses by policy is remembered
 * in `writeDenied`, so the publish stops instead of retrying, and a save that failed for any other
 * reason than another writer's reservation in `saveFailed`. The toolkit returns the id of an
 * entry it reserved on the legacy cache service even when the upload after the reservation
 * failed, and says so only in its log, so a save that logs a failure did not create the entry.
 */

const RESERVATION =
  /^::warning::(Cache reservation failed: |Failed to save: Unable to reserve cache)/;
const FAILED = /Failed to save: /;
/** Another writer holds the key, whether the toolkit logs it as a warning or a plain line. */
const RESERVED = /(Cache reservation failed: |Failed to save: Unable to reserve cache)/;
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

const MODES = ['none', 'read', 'write', 'write-only'];

/** Whether the cache mode in `env` lets the job read and write the cache. */
function cacheMode(env = process.env) {
  const mode = String(env.ACTIONS_CACHE_MODE || '')
    .trim()
    .toLowerCase();
  if (!MODES.includes(mode)) return { readable: true, writable: true };
  return {
    readable: mode === 'read' || mode === 'write',
    writable: mode === 'write' || mode === 'write-only',
  };
}

function toolkitCache(cache, env = process.env) {
  const adapter = {
    writeDenied: false,
    saveFailed: false,
    available: () => cache.isFeatureAvailable(),
    readable: () => cacheMode(env).readable,
    writable: () => cacheMode(env).writable,
    async restore(dir, key, restoreKeys = []) {
      return (await cache.restoreCache([dir], key, restoreKeys)) || '';
    },
    async lookup(dir, key, restoreKeys = []) {
      return (await cache.restoreCache([dir], key, restoreKeys, { lookupOnly: true })) || '';
    },
    async save(dir, key) {
      let failed = false;
      let reserved = false;
      const id = await filtered(
        (line) => {
          if (DENIED.test(line)) adapter.writeDenied = true;
          if (FAILED.test(line)) failed = true;
          if (RESERVED.test(line)) reserved = true;
          return RESERVATION.test(line) ? line.replace('::warning::', '') : line;
        },
        () => cache.saveCache([dir], key)
      );
      const created = id !== -1 && !failed;
      adapter.saveFailed = !created && !reserved;
      return created;
    },
  };
  return adapter;
}

module.exports = { cacheMode, toolkitCache };
