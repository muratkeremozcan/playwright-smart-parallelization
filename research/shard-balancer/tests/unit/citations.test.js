/**
 * The citation check: line ranges, quotes found and missed, a range past the end of the file, and
 * the de-duplication of the citations of the decisions.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  checkCitations,
  citationsOf,
  fetchUpstream,
  parseLines,
  upstreamUrl,
  verify,
} = require('../../citations');
const { ALL } = require('../../decisions');

const TEXT = ['one', 'two  words', 'three', 'four', 'five'].join('\n');

describe('parseLines', () => {
  test('reads single lines and ranges', () => {
    assert.deepStrictEqual(parseLines('2-3,5'), [
      [2, 3],
      [5, 5],
    ]);
  });

  test('refuses a backward or empty range', () => {
    assert.throws(() => parseLines('3-2'), /bad line range/);
    assert.throws(() => parseLines('x'), /bad line range/);
  });
});

describe('verify', () => {
  test('finds a quote at its lines, whitespace collapsed', () => {
    assert.deepStrictEqual(verify(TEXT, { lines: '2-3', quote: 'two words three' }), {
      ok: true,
      reason: null,
    });
  });

  test('misses a quote outside its lines', () => {
    assert.strictEqual(verify(TEXT, { lines: '4-5', quote: 'two' }).ok, false);
  });

  test('fails a range past the end of the file', () => {
    assert.match(verify(TEXT, { lines: '5-9', quote: 'five' }).reason, /past the end/);
  });
});

describe('checkCitations', () => {
  test('reads upstream files through the given reader at the commit', async () => {
    const urls = [];
    const results = await checkCitations(
      [{ source: 'upstream', file: 'src/a.ts', lines: '1', quote: 'one' }],
      {
        commit: 'c0ffee',
        fetchText: async (url) => {
          urls.push(url);
          return TEXT;
        },
      }
    );
    assert.deepStrictEqual(urls, [upstreamUrl('c0ffee', 'src/a.ts')]);
    assert.strictEqual(results[0].ok, true);
  });

  test('turns a read error into a failed citation', async () => {
    const [result] = await checkCitations(
      [{ source: 'upstream', file: 'x', lines: '1', quote: 'x' }],
      {
        commit: 'c',
        fetchText: async () => {
          throw new Error('offline');
        },
      }
    );
    assert.deepStrictEqual([result.ok, result.reason], [false, 'offline']);
  });
});

describe('fetchUpstream', () => {
  test('retries a dropped request and returns the text', async () => {
    let calls = 0;
    const get = async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch failed');
      return { ok: true, status: 200, text: async () => 'body' };
    };
    assert.strictEqual(await fetchUpstream('u', { get, pauseMs: 0 }), 'body');
    assert.strictEqual(calls, 3);
  });

  test('retries a body read that fails once', async () => {
    let calls = 0;
    const get = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => {
          if (calls === 1) throw new Error('terminated');
          return 'body';
        },
      };
    };
    assert.strictEqual(await fetchUpstream('u', { get, pauseMs: 0 }), 'body');
    assert.strictEqual(calls, 2);
  });

  test('fails at once on a 404 and after the last attempt otherwise', async () => {
    let calls = 0;
    const missing = async () => {
      calls += 1;
      return { ok: false, status: 404 };
    };
    await assert.rejects(fetchUpstream('u', { get: missing, pauseMs: 0 }), /404/);
    assert.strictEqual(calls, 1);
    await assert.rejects(
      fetchUpstream('u', {
        attempts: 2,
        pauseMs: 0,
        get: async () => {
          throw new Error('down');
        },
      }),
      /down/
    );
  });
});

describe('citationsOf', () => {
  test('keeps the union of the sources of all entries, each once, in order of first use', () => {
    const a = { file: 'a.ts', lines: '1', quote: 'x' };
    const b = { source: 'flakiness', file: 'b.js', lines: '2', quote: 'y' };
    const c = { file: 'a.ts', lines: '1', quote: 'other quote' };
    const result = citationsOf([
      { sources: [a, b] },
      { sources: [{ ...a, source: 'upstream' }, c] },
    ]);
    assert.deepStrictEqual(result, [
      { source: 'upstream', file: 'a.ts', lines: '1', quote: 'x' },
      { source: 'flakiness', file: 'b.js', lines: '2', quote: 'y' },
      { source: 'upstream', file: 'a.ts', lines: '1', quote: 'other quote' },
    ]);
  });
});

describe('the citations of the decisions', () => {
  test('are listed once each, with a source', () => {
    const citations = citationsOf(ALL);
    const keys = citations.map((c) => JSON.stringify([c.source, c.file, c.lines, c.quote]));
    assert.strictEqual(new Set(keys).size, keys.length);
    for (const c of citations)
      assert.ok(['upstream', 'flakiness', 'playwright'].includes(c.source), c.file);
  });
});
