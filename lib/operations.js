'use strict';

/**
 * Counts the network operations of one step of the Action: the cache, artifact and REST calls it
 * makes through the clients src/index.js hands it. A call that returns counts as done, one that
 * throws as failed, so a retry after a failure the service caused is told apart from an operation
 * the code path makes. The step ends with `line(step)`, which the repository's e2e workflow reads
 * to hold each count to a budget (tests/e2e/operations.js):
 *
 *   the main step made network operations: cache-restore 1, cache-lookup 0, ...; failed 0
 */

/** Every kind, in the order the line lists them. */
const KINDS = [
  'cache-restore',
  'cache-lookup',
  'cache-save',
  'artifact-find',
  'artifact-list',
  'artifact-upload',
  'artifact-download',
  'api-request',
];

function operationCounter() {
  const done = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  let failed = 0;
  const counted =
    (kind, fn) =>
    async (...args) => {
      try {
        const result = await fn(...args);
        done[kind] += 1;
        return result;
      } catch (error) {
        failed += 1;
        throw error;
      }
    };
  return {
    /**
     * The cache adapter of lib/cache.js with its reads and writes counted. Everything else, such as
     * `writeDenied`, which a save sets on the adapter itself, reads through to it.
     */
    cache(adapter) {
      return Object.assign(Object.create(adapter), {
        restore: counted('cache-restore', adapter.restore.bind(adapter)),
        lookup: counted('cache-lookup', adapter.lookup.bind(adapter)),
        save: counted('cache-save', adapter.save.bind(adapter)),
      });
    },
    /** The artifact client of src/index.js with each of its calls counted. */
    artifacts(client) {
      return {
        find: counted('artifact-find', client.find),
        list: counted('artifact-list', client.list),
        upload: counted('artifact-upload', client.upload),
        download: counted('artifact-download', client.download),
      };
    },
    /** `fetch` with each request counted, whatever its status. */
    fetch(fetchImpl) {
      return typeof fetchImpl === 'function' ? counted('api-request', fetchImpl) : fetchImpl;
    },
    counts: () => ({ ...done, failed }),
    line: (step) =>
      `the ${step} step made network operations: ` +
      `${KINDS.map((kind) => `${kind} ${done[kind]}`).join(', ')}; failed ${failed}`,
  };
}

const LINE =
  /\[playwright-smart-parallelization\] the (main|post|finish) step made network operations: (.+); failed (\d+)$/;

/** The counts one job log holds: `{ main, post, finish }`, each `{ kind: n, failed }` or undefined. */
function readOperations(log) {
  const found = {};
  for (const line of String(log).split('\n')) {
    const match = LINE.exec(line.trimEnd());
    if (!match) continue;
    const counts = { failed: Number(match[3]) };
    for (const part of match[2].split(', ')) {
      const [kind, n] = part.split(' ');
      counts[kind] = Number(n);
    }
    found[match[1]] = counts;
  }
  return found;
}

module.exports = { KINDS, operationCounter, readOperations };
