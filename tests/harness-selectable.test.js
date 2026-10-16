/**
 * Playwright's `--test-list` selects by project name, the file of the test call and a title-path
 * prefix, after splitting each line on "›" and trimming it. The harness rejects, before any run, a
 * suite that selector cannot pick out exactly (see `assertSelectable`). The rejection lives where
 * selectors are built: `testListPartition` and the negative control. Native sharding selects no
 * test by title and still lists and qualifies such a suite. The fixture configs
 * `unselectable-*.config.js` are accepted by Playwright and rejected here; the clean one is not.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listIntended, qualify } = require('../harness/index.js');
const { runNegativeControl } = require('../harness/negative-control.js');
const { assertSelectable, testListPartition } = require('../harness/partitions.js');
const { loadSentinel } = require('../harness/leaves.js');
const { main } = require('../harness/cli.js');
const { requireFixture } = require('./support/fixture.js');

let sequence = 0;
function leaf(titlePath, extra = {}) {
  sequence += 1;
  const project = extra.project || 'p';
  const file = extra.file || 'a.spec.js';
  return {
    key: `k${sequence}`,
    label: `${project}|${file}|${titlePath.join(' › ')}|#0`,
    testRef: `${project}|${extra.specFile || file}|${titlePath.join(' › ')}`,
    project,
    file,
    specFile: extra.specFile || file,
    titlePath,
    repeatIndex: 0,
    serialGroup: null,
    dependency: false,
    line: 1,
    column: 1,
    ...extra,
  };
}

describe('assertSelectable on synthetic leaves', () => {
  test('accepts distinct titles, a shared prefix of suites and the same title in two files', () => {
    assert.doesNotThrow(() =>
      assertSelectable([
        leaf(['suite', 'one']),
        leaf(['suite', 'two']),
        leaf(['solo']),
        leaf(['solo'], { file: 'b.spec.js' }),
        leaf(['solo'], { project: 'q' }),
      ])
    );
  });

  test('treats the repeats of one test as one test', () => {
    const one = leaf(['t']);
    assert.doesNotThrow(() => assertSelectable([one, { ...one, key: 'r1', repeatIndex: 1 }]));
  });

  for (const [name, title, reason] of [
    ['a separator in a title', 'a › b', /contains "›"/],
    ['a NUL in a title', 'a\u0000b', /control character/],
    ['a newline in a title', 'a\nb', /newline/],
    ['a tab in a title', 'a\tb', /control character/],
    ['leading whitespace in a title', ' a', /leading or trailing whitespace/],
    ['trailing whitespace in a title', 'a ', /leading or trailing whitespace/],
  ]) {
    test(`rejects ${name}, naming the leaf and the title`, () => {
      const bad = leaf(['suite', title]);
      assert.throws(
        () => assertSelectable([leaf(['fine']), bad]),
        (error) => {
          assert.ok(error.message.startsWith(`${bad.label} cannot be selected exactly`));
          assert.match(error.message, /its title 2/);
          assert.match(error.message, reason);
          return true;
        }
      );
    });
  }

  test('rejects a spec file a load-only line would carry', () => {
    assert.throws(
      () => assertSelectable([leaf(['t'], { file: 'helper.js', specFile: 'a › b.spec.js' })]),
      /its spec file "a › b\.spec\.js" contains "›"/
    );
  });

  test('rejects a string that is not well-formed UTF-16, which a UTF-8 list file corrupts', () => {
    assert.throws(
      () => assertSelectable([leaf(['lone \ud800 half'])]),
      /is not well-formed UTF-16/
    );
    assert.throws(() => assertSelectable([leaf(['t'], { project: 'p\udc00' })]), /its project/);
    assert.throws(() => assertSelectable([leaf(['t'], { file: 'f\ud800.spec.js' })]), /its file/);
    assert.doesNotThrow(() => assertSelectable([leaf(['paired \ud83d\ude00 emoji'])]));
  });

  test('rejects a suite title with a separator by its depth', () => {
    assert.throws(() => assertSelectable([leaf(['a › b', 'child'])]), /its title 1/);
  });

  test('rejects a project name or a file with a separator or whitespace', () => {
    assert.throws(() => assertSelectable([leaf(['t'], { project: 'p › q' })]), /its project/);
    assert.throws(() => assertSelectable([leaf(['t'], { project: ' p' })]), /its project/);
    assert.throws(() => assertSelectable([leaf(['t'], { file: 'a › b.spec.js' })]), /its file/);
  });

  test('rejects a test whose title path is a prefix of another, naming both', () => {
    const group = leaf(['group']);
    const child = leaf(['group', 'child']);
    assert.throws(
      () => assertSelectable([child, group]),
      (error) => {
        assert.ok(error.message.startsWith(`${group.label} and ${child.label} cannot be selected`));
        assert.match(error.message, /prefix of the other/);
        return true;
      }
    );
  });

  test('rejects two different tests with one project, call file and title path', () => {
    const a = leaf(['shared'], { file: 'factory.js', specFile: 'a.spec.js' });
    const b = leaf(['shared'], { file: 'factory.js', specFile: 'b.spec.js' });
    assert.throws(
      () => assertSelectable([a, b]),
      (error) => {
        assert.match(error.message, /no line tells them apart/);
        assert.ok(error.message.includes(a.label) && error.message.includes(b.label));
        return true;
      }
    );
  });

  test('skips dependency leaves, which no line selects', () => {
    assert.doesNotThrow(() =>
      assertSelectable([leaf(['t']), leaf(['a › b'], { dependency: true })])
    );
  });
});

describe('loadSentinel', () => {
  test('is a control-character title no listed title has', () => {
    const sentinel = loadSentinel([leaf(['ordinary'])]);
    assert.ok(sentinel.startsWith('\u0000'));
  });

  test('lengthens itself until it is absent from every title path', () => {
    const first = loadSentinel([]);
    const second = loadSentinel([leaf(['suite', first])]);
    assert.notStrictEqual(second, first);
    assert.ok(second.startsWith(first));
    const third = loadSentinel([leaf([first]), leaf(['x', second])]);
    assert.ok(![first, second].includes(third));
  });
});

describe('what Playwright accepts and a test-list selector cannot pick out', () => {
  const cwd = requireFixture();
  const dirs = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-selectable-'));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const CASES = [
    ['separator', /its title 1 "a › b" contains "›"/],
    ['whitespace', /its title 1 "trailing space " has leading or trailing whitespace/],
    ['nul', /its title 1 "nul\\u0000title" contains/],
    ['newline', /its title 1 "line\\nbreak" contains/],
    ['prefix', /prefix of the other/],
    ['project', /its project "p › q" contains "›"/],
    ['specfile', /its spec file "a › b\.spec\.js" contains "›"/],
    ['surrogate', /its title 1 .* is not well-formed UTF-16/],
  ];

  test('the clean config passes every check', () => {
    const { leaves } = listIntended({ cwd, config: 'unselectable-plain.config.js' });
    assert.doesNotThrow(() => assertSelectable(leaves));
    assert.doesNotThrow(() => testListPartition([leaves.map((l) => l.key)], leaves, tempDir()));
  });

  for (const [name, message] of CASES) {
    describe(`unselectable-${name}.config.js`, () => {
      const config = `unselectable-${name}.config.js`;

      test('Playwright lists it, so listIntended accepts it', () => {
        assert.ok(listIntended({ cwd, config }).leaves.length > 0);
      });

      test('native sharding still qualifies it', () => {
        const report = qualify({ cwd, config, shards: 2 }, { quiet: true });
        assert.deepStrictEqual(report.violations, []);
      });

      test('testListPartition rejects it', () => {
        const { leaves } = listIntended({ cwd, config });
        assert.throws(
          () => testListPartition([leaves.map((l) => l.key)], leaves, tempDir()),
          message
        );
      });

      test('the negative control rejects it before any run', () => {
        assert.throws(() => runNegativeControl({ cwd, config }), message);
      });

      test('the CLI negative control exits 2 with the error', () => {
        const written = [];
        const code = main(['--cwd', cwd, '--config', config, '--negative-control'], {
          stdout: { write: () => {} },
          stderr: { write: (text) => written.push(text) },
        });
        assert.strictEqual(code, 2);
        assert.match(written.join(''), message);
      });
    });
  }
});

describe('a list an engine supplies', () => {
  const cwd = requireFixture();
  const dirs = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Writes one list file per shard of lines and returns the shards that name them. */
  function shardsOf(lists, flag = '--test-list') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-engine-'));
    dirs.push(dir);
    return lists.map((lines, index) => {
      const file = path.join(dir, `shard-${index + 1}.txt`);
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      return { args: [flag, file] };
    });
  }

  // `group` and `group › child`: a line for `group` also selects the child, so splitting them
  // runs the child twice.
  const SPLIT = [
    ['[p] › prefix.spec.js:6:1 › group'],
    ['[p] › prefix.spec.js:9:3 › group › child'],
  ];
  const prefix = { cwd, config: 'unselectable-prefix.config.js' };

  test('is checked against the contract before any shard runs', () => {
    assert.throws(
      () => qualify({ ...prefix, partition: shardsOf(SPLIT) }, { quiet: true }),
      /prefix of the other/
    );
  });

  test('is checked in the --test-list=FILE and --test-list-invert forms', () => {
    const [first, second] = shardsOf(SPLIT);
    const attached = (shard) => ({ args: [`--test-list=${shard.args[1]}`] });
    assert.throws(
      () => qualify({ ...prefix, partition: [attached(first), attached(second)] }, { quiet: true }),
      /prefix of the other/
    );
    assert.throws(
      () =>
        qualify({ ...prefix, partition: shardsOf(SPLIT, '--test-list-invert') }, { quiet: true }),
      /prefix of the other/
    );
  });

  test('is checked when the list is forwarded instead of supplied', () => {
    const [first] = shardsOf(SPLIT);
    assert.throws(
      () =>
        qualify({ ...prefix, forward: ['--test-list', first.args[1]], shards: 2 }, { quiet: true }),
      /prefix of the other/
    );
  });

  test('may name a selectable suite, which runs and qualifies', () => {
    const lines = [['[p] › plain.spec.js:5:1 › an ordinary title'], []];
    const report = qualify(
      { cwd, config: 'unselectable-plain.config.js', partition: shardsOf(lines) },
      { quiet: true }
    );
    assert.deepStrictEqual(report.violations, []);
  });

  test('is found after an option that takes a value', () => {
    const [first, second] = shardsOf(SPLIT);
    const after = (shard) => ({ args: ['--workers', '1', '-g', 'x|group', ...shard.args] });
    assert.throws(
      () => qualify({ ...prefix, partition: [after(first), after(second)] }, { quiet: true }),
      /prefix of the other/
    );
  });

  test('is not seen in the value of an option, in either spelling', () => {
    // Playwright reads `--test-list` here as the grep-invert pattern, so no list is in play and
    // the native partition of an unselectable suite still qualifies.
    for (const forward of [['--grep-invert', '--test-list'], ['--grep-invert=--test-list']]) {
      const report = qualify({ ...prefix, forward, shards: 2 }, { quiet: true });
      assert.deepStrictEqual(report.violations, [], forward.join(' '));
    }
    const shard = (index) => ({ args: [`--shard=${index}/2`, '--grep-invert', '--test-list'] });
    const report = qualify({ ...prefix, partition: [shard(1), shard(2)] }, { quiet: true });
    assert.deepStrictEqual(report.violations, []);
  });

  test('is not checked for a native partition, which selects no test by title', () => {
    const report = qualify({ ...prefix, shards: 2 }, { quiet: true });
    assert.deepStrictEqual(report.violations, []);
  });
});
