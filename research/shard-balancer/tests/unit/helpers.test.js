/**
 * The pure helpers the experiments rest on: the plan line parser, the median the package prices a
 * test at, the model of the Actions cache, the count of split files, our own estimate hierarchy and
 * the row format.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logLines, parsePlanLine } = require('../../drive');
const { median } = require('../../lib/median');
const { filesWhole } = require('../../scenarios/assignment');
const { cacheModel } = require('../../scenarios/history');
const { ourEstimate } = require('../../scenarios/planning');
const { harnessFacts, row } = require('../../scenarios/row');

const PLAN =
  'shard 1/3: 1 files, 5 tests, ~9.1s (all shards 7.3s-9.1s, largest group 9.0s), timings 7cb4738247c0, 52/52 tests known, 1 worker(s), plan 628fd58db1c4';

describe('parsePlanLine and logLines', () => {
  test('parse a plan line without notes', () => {
    assert.deepStrictEqual(parsePlanLine(PLAN), {
      shard: 1,
      total: 3,
      files: 1,
      tests: 5,
      predicted: '9.1s',
      range: ['7.3s', '9.1s'],
      largestGroup: '9.0s',
      timingsSha: '7cb4738247c0',
      known: 52,
      listed: 52,
      workers: 1,
      planSha: '628fd58db1c4',
      notes: [],
    });
  });

  test('parse the notes after the plan sha', () => {
    const line = `${PLAN}, 3 group(s) joined to others that share a lock, Playwright internals not found so files are kept whole`;
    assert.deepStrictEqual(parsePlanLine(line).notes, [
      '3 group(s) joined to others that share a lock',
      'Playwright internals not found so files are kept whole',
    ]);
  });

  test('return null for a line that is no plan', () => {
    assert.strictEqual(
      parsePlanLine("shard 1/2: no timings file at x; using Playwright's built-in sharding"),
      null
    );
  });

  test('keep only the lines of the package, without colors or prefix', () => {
    const output = `  ✓ a test\n\u001b[2mplaywright-shard-balancer: ${PLAN}\u001b[22m\nother\nplaywright-shard-balancer: ok`;
    assert.deepStrictEqual(logLines(output), [`${PLAN}`, 'ok']);
  });
});

describe('median', () => {
  test('takes the middle of an odd count', () => {
    assert.strictEqual(median([5, 1, 3]), 3);
  });

  test('rounds the mean of the middle two of an even count', () => {
    assert.strictEqual(median([1, 2, 4, 10]), 3);
    assert.strictEqual(median([1, 2]), 2);
  });
});

describe('cacheModel', () => {
  test('keeps entries immutable and restores an exact key, else the newest created by prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-psb-cache-'));
    try {
      const write = (name, text) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, text);
        return file;
      };
      const cache = cacheModel();
      assert.strictEqual(cache.save('t-2', write('a', 'two')), true);
      assert.strictEqual(cache.save('t-1', write('b', 'one')), true);
      assert.strictEqual(cache.save('t-1', write('c', 'again')), false);
      const target = path.join(dir, 'out');
      assert.strictEqual(cache.restore('t-2', 't-', target), 't-2');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'two');
      assert.strictEqual(cache.restore('t-9', 't-', target), 't-1');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'one');
      assert.strictEqual(cache.restore('u-1', 'u-', target), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filesWhole', () => {
  test('counts the project and file pairs that ran on more than one shard, setup aside', () => {
    const leaf = (key, project, file) => ({ key, project, file });
    const run = {
      listing: { leaves: [{ key: 's', dependency: true }] },
      raw: [
        {
          index: 1,
          leaves: [
            leaf('s', 'setup', 'setup.js'),
            leaf('a1', 'c', 'a.js'),
            leaf('b1', 'c', 'b.js'),
          ],
        },
        {
          index: 2,
          leaves: [
            leaf('s', 'setup', 'setup.js'),
            leaf('a2', 'c', 'a.js'),
            leaf('a3', 'f', 'a.js'),
          ],
        },
      ],
    };
    assert.strictEqual(filesWhole(run), 1);
  });
});

describe('ourEstimate', () => {
  const timings = {
    tests: {
      '[c] › f.js › d › one': { samples: [100] },
      '[c] › f.js › d › two': { samples: [300] },
      '[c] › f.js › loose': { samples: [1000] },
      '[c] › g.js › x': { samples: [50] },
      '[w] › f.js › d › one': { samples: [5000] },
    },
  };
  const at = (key, project, file) => ourEstimate(timings, { key, project, file });

  test('prices each level by its own median', () => {
    assert.deepStrictEqual(at('[c] › f.js › d › one', 'c', 'f.js'), { level: 'known', ms: 100 });
    assert.deepStrictEqual(at('[c] › f.js › d › new', 'c', 'f.js'), { level: 'describe', ms: 200 });
    assert.deepStrictEqual(at('[c] › f.js › new', 'c', 'f.js'), { level: 'file', ms: 300 });
    assert.deepStrictEqual(at('[c] › h.js › new', 'c', 'h.js'), { level: 'project', ms: 200 });
    assert.deepStrictEqual(at('[z] › f.js › new', 'z', 'f.js'), { level: 'suite', ms: 300 });
  });
});

describe('row and harnessFacts', () => {
  test('a row passes when the observation matches its claim, and carries its group', () => {
    assert.deepStrictEqual(row('h.x', 'claim', true, { a: 1 }, 'finding'), {
      id: 'h.x',
      group: 'history',
      claim: 'claim',
      status: 'pass',
      facts: { a: 1 },
      finding: 'finding',
    });
    assert.strictEqual(row('sim.x', 'c', false, {}, 'f').status, 'fail');
  });

  test('a row id needs a known group', () => {
    assert.throws(() => row('zz.x', 'c', true, {}, 'f'), /no group/);
  });

  test('harnessFacts takes the verdict, the violations and the exit codes', () => {
    const run = {
      summary: { ok: false, kinds: { missing: 2 } },
      raw: [{ exitCode: 0 }, { exitCode: 1 }],
    };
    assert.deepStrictEqual(harnessFacts(run), {
      harnessOk: false,
      violations: { missing: 2 },
      exitCodes: [0, 1],
    });
  });
});
