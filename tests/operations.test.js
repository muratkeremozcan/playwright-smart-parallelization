/**
 * The network operation counter of lib/operations.js: what it counts, what it leaves to the
 * clients it wraps, and the line a step ends with.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { KINDS, operationCounter, readOperations } = require('../lib/operations');

test('counts the calls that returned by kind, and the calls that threw apart', async () => {
  const ops = operationCounter();
  const adapter = {
    writeDenied: false,
    available: () => true,
    restore: async () => 'k',
    lookup: async () => '',
    async save() {
      this.writeDenied = true;
      return false;
    },
  };
  const cache = ops.cache(adapter);
  const artifacts = ops.artifacts({
    find: async () => null,
    list: async () => [],
    upload: async () => {
      throw new Error('503');
    },
    download: async () => {},
  });
  const fetchImpl = ops.fetch(async () => ({ status: 404 }));

  assert.strictEqual(await cache.restore('d', 'k'), 'k');
  await cache.lookup('d', 'k');
  assert.strictEqual(await cache.save('d', 'k'), false);
  assert.strictEqual(
    cache.writeDenied,
    true,
    'a save sets writeDenied on the adapter it reads through to'
  );
  assert.strictEqual(cache.available(), true);
  await artifacts.find('n');
  await artifacts.list();
  await artifacts.download(1, 'dir');
  await assert.rejects(artifacts.upload('n', [], 'dir'), /503/);
  await fetchImpl('https://api.github.com/x');

  assert.deepStrictEqual(ops.counts(), {
    'cache-restore': 1,
    'cache-lookup': 1,
    'cache-save': 1,
    'artifact-find': 1,
    'artifact-list': 1,
    'artifact-upload': 0,
    'artifact-download': 1,
    'api-request': 1,
    failed: 1,
    lost: 1,
  });
  assert.strictEqual(ops.fetch(undefined), undefined, 'no fetch stays no fetch');
});

test('the line a step ends with lists every kind, and reads back from a job log', () => {
  const ops = operationCounter();
  const line = ops.line('post');
  assert.strictEqual(
    line,
    `the post step made network operations: ${KINDS.map((k) => `${k} 0`).join(', ')}; failed 0; lost 0`
  );
  const log = [
    `2026-10-17T12:00:00.0000000Z [playwright-smart-parallelization] ${line.replace('cache-save 0', 'cache-save 2')}\r`,
    '2026-10-17T12:00:00.0000000Z the post step made network operations: cache-save 9; failed 0; lost 0',
  ].join('\n');
  const read = readOperations(log);
  assert.strictEqual(read.post['cache-save'], 2);
  assert.strictEqual(read.post.failed, 0);
  assert.strictEqual(read.post.lost, 0);
  assert.strictEqual(read.main, undefined);
});
