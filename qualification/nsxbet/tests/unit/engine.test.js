/** Tests for the command lines the wrapper builds for the engine CLI. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { assignArgs, extractArgs, lastJsonLine, mergeArgs, runEngine } = require('../../engine');

describe('assignArgs', () => {
  test('passes the list and shard count and nothing else by default', () => {
    assert.deepStrictEqual(assignArgs({ testList: 'l.json', shards: 3 }), [
      'assign',
      '--test-list',
      'l.json',
      '--shards',
      '3',
    ]);
  });

  test('passes timing file, project, timeout and verbose when given', () => {
    const args = assignArgs({
      testList: 'l.json',
      shards: 2,
      timingFile: 't.json',
      project: 'chromium',
      timeout: 1,
      verbose: true,
    });
    assert.deepStrictEqual(args.slice(5), [
      '--timing-file',
      't.json',
      '--project',
      'chromium',
      '--timeout',
      '1',
      '--verbose',
    ]);
  });

  test('turns file affinity off with --no-file-affinity and nothing else', () => {
    assert.ok(
      assignArgs({ testList: 'l', shards: 2, fileAffinity: false }).includes('--no-file-affinity')
    );
    assert.ok(!assignArgs({ testList: 'l', shards: 2 }).includes('--no-file-affinity'));
  });

  test('passes a zero penalty and a large penalty', () => {
    assert.deepStrictEqual(assignArgs({ testList: 'l', shards: 2, penalty: 0 }).slice(-2), [
      '--file-affinity-penalty',
      '0',
    ]);
    assert.deepStrictEqual(assignArgs({ testList: 'l', shards: 2, penalty: 100000000 }).slice(-2), [
      '--file-affinity-penalty',
      '100000000',
    ]);
  });
});

describe('extractArgs and mergeArgs', () => {
  test('extract-timing carries report, project, shard and output', () => {
    assert.deepStrictEqual(
      extractArgs({ reportFile: 'r.json', outputFile: 'o.json', project: 'firefox', shard: 2 }),
      [
        'extract-timing',
        '--report-file',
        'r.json',
        '--project',
        'firefox',
        '--shard',
        '2',
        '--output-file',
        'o.json',
      ]
    );
  });

  test('merge-timing carries every artifact, the existing history and the pruning options', () => {
    assert.deepStrictEqual(
      mergeArgs({
        existing: 'h.json',
        artifacts: ['a.json', 'b.json'],
        output: 'out.json',
        pruneDays: 7,
        currentTests: 'c.txt',
      }),
      [
        'merge-timing',
        '--new',
        'a.json',
        'b.json',
        '--output',
        'out.json',
        '--existing',
        'h.json',
        '--prune-days',
        '7',
        '--current-tests',
        'c.txt',
      ]
    );
  });

  test('merge-timing without existing history has no --existing', () => {
    assert.ok(!mergeArgs({ artifacts: ['a'], output: 'o' }).includes('--existing'));
  });
});

describe('runEngine', () => {
  test('keeps the reason when the process cannot start', () => {
    const result = runEngine(['--version'], {
      root: '/nonexistent',
      wrap: ['psp-no-such-command'],
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
  });
});

describe('lastJsonLine', () => {
  test('returns the last JSON object line and ignores other output', () => {
    assert.deepStrictEqual(lastJsonLine('warning\n{"a":1}\nnoise\n{"b":2}\n'), { b: 2 });
    assert.strictEqual(lastJsonLine('no json here\n'), null);
    assert.strictEqual(lastJsonLine('{broken\n'), null);
  });
});
