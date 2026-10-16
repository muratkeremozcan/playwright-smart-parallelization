# Playwright `--test-list` selection limits

`playwright test --test-list <file>` is the way an engine hands each shard an explicit set of tests.
It is a lossy selector. This note records what it can and cannot pick out, checked on three
versions, so the engine work and the decision record can cite it. The qualification harness turns
each limit into a rejection before any run (`assertSelectable` in `harness/partitions.js`).

Versions checked: `@playwright/test` 1.56.1, 1.60.0 and 1.64.1 (the latest at the time of writing).
The reproduction below runs against any installed version.

## How a line is read

A line is `[project] › file:line:column › title › title`. Playwright splits it on `›`, trims each
token, and matches a test when all of these hold:

- the project name equals the bracketed name, when a bracketed name is given;
- the file of the test call, relative to the config `rootDir`, equals the file in the line;
- the line's titles are a prefix of the test's title path (suite titles, then the test title).

The line and the column are parsed and ignored. The files named by the lines also decide which
files Playwright loads (`loadFileFilters`), and a positional file argument is ANDed with them.

## Limits

| #   | Limit                                                                                                                                    | 1.56.1                                        | 1.60.0 and 1.64.1                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| 1   | A line for `group` selects the test titled `group` and, from 1.60.0, every test under the suite `group`: the match is a title prefix.    | selects the test only                         | selects the test and the child                 |
| 2   | `›` is the separator, so a title or a project name containing it cannot be written. `a › b` is read as the titles `a`, `b`.              | selects nothing                               | selects nothing                                |
| 3   | Tokens are trimmed, so a title with leading or trailing whitespace cannot be selected.                                                   | selects nothing                               | selects nothing                                |
| 4   | A test matches by the file of its call. Tests a helper registers sit at the helper's file, which is not a test file.                     | selects the tests of both specs that call it  | selects nothing: the helper is not loaded      |
| 5   | A line that names a spec with a title no test has selects nothing by itself. Next to a helper line it loads that spec.                   | does not narrow: both specs' tests are chosen | loads that spec only, so only its tests run    |
| 6   | Two specs that call one helper register tests with one project, call file and title path. No line tells them apart once both are loaded. | both selected                                 | both selected                                  |
| 7   | A positional file argument is ANDed with the files the list names, not added to them.                                                    | narrows to that spec                          | selects nothing when the list names the helper |

## What the harness does

- `assertSelectable` rejects a project name, file, suite title or test title with `›`, a control
  character, a newline or surrounding whitespace (rows 2 and 3).
- It rejects a test whose title path is a prefix of another's in the same project and call file, and
  it names both tests (row 1).
- It rejects two different tests with one project, call file and title path, and names both
  (row 6). A helper that is called by one spec only is fine.
- `testListPartition` adds a load-only line for the spec of each test whose call file is not its
  spec, with a title that no title path in the listing has (rows 4 and 5). From 1.60.0 the specs a
  shard loads decide which of a helper's tests it runs. On 1.56.1 the extra line is harmless.
- Native sharding selects no test by title, so these limits do not apply to it.

## Reproduction

Run it in a directory where `@playwright/test` is installed. It writes a small project under the
current directory, lists with each line shape, and prints the number of tests selected.

```js
// Reproductions of what `playwright test --test-list` can and cannot select. Run in a directory
// where @playwright/test is installed: node repro.js
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(process.cwd(), 'tl-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const head = "const { test } = require('@playwright/test');\n";
write(
  'playwright.config.js',
  "module.exports = { testDir: './t', reporter: 'list', projects: [{ name: 'p' }, { name: 'p › q' }] };\n"
);
write(
  't/prefix.spec.js',
  `${head}test('group', async () => {});\ntest.describe('group', () => { test('child', async () => {}); });\n`
);
write('t/sep.spec.js', `${head}test('a › b', async () => {});\n`);
write('t/space.spec.js', `${head}test('trailing ', async () => {});\n`);
write(
  't/helper.js',
  "const { test } = require('@playwright/test');\nmodule.exports = () => { test('from helper', async () => {}); };\n"
);
write('t/h1.spec.js', "require('./helper.js')();\n");
write('t/h2.spec.js', "require('./helper.js')();\n");
write('t/own.spec.js', `${head}test('own', async () => {});\n`);
write('t/load.spec.js', `${head}test('x', async () => {});\n`);

const cli = require.resolve('@playwright/test/cli', { paths: [process.cwd()] });
function listing(lines, extra = []) {
  const file = path.join(root, 'list.txt');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const run = spawnSync(process.execPath, [cli, 'test', '--list', '--test-list', file, ...extra], {
    cwd: root,
    encoding: 'utf8',
  });
  const tests = run.stdout
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim());
  return tests;
}
const show = (name, tests) => console.log(`${name}: ${tests.length} ${JSON.stringify(tests)}`);

show(
  '1 prefix: line "group" selects the test and the suite',
  listing(['[p] › prefix.spec.js:1:1 › group'])
);
show(
  '1 prefix: line "group › child" selects only the child',
  listing(['[p] › prefix.spec.js:1:1 › group › child'])
);
show(
  '2 separator: line "a › b" is read as titles a, b',
  listing(['[p] › sep.spec.js:1:1 › a › b'])
);
show('2 separator: project "p › q" cannot be named', listing(['[p › q] › own.spec.js:1:1 › own']));
show(
  '3 trim: line with a trailing space in the title',
  listing(['[p] › space.spec.js:1:1 › trailing '])
);
show(
  '4 call file: helper tests match the helper file, which is not loaded',
  listing(['[p] › helper.js:2:30 › from helper'])
);
show(
  '4 call file: plus a load-only line for h1 loads h1 only',
  listing(['[p] › helper.js:2:30 › from helper', '[p] › h1.spec.js:1:1 › \u0000load only'])
);
show(
  '4 call file: plus load-only lines for h1 and h2 select both',
  listing([
    '[p] › helper.js:2:30 › from helper',
    '[p] › h1.spec.js:1:1 › \u0000load only',
    '[p] › h2.spec.js:1:1 › \u0000load only',
  ])
);
show(
  '4 call file: a positional file filter is ANDed with the list',
  listing(['[p] › helper.js:2:30 › from helper'], ['h1.spec.js'])
);
show(
  '5 load-only: a spec named with a title no test has selects nothing',
  listing(['[p] › load.spec.js:1:1 › \u0000load only'])
);
show(
  '5 load-only: the same line with a real title selects the test',
  listing(['[p] › load.spec.js:1:1 › x'])
);
show('6 line and column are ignored', listing(['[p] › own.spec.js:99:99 › own']));
```

Output on 1.64.1:

```text
1 prefix: line "group" selects the test and the suite: 2 ["[p] › prefix.spec.js:2:1 › group","[p] › prefix.spec.js:3:32 › group › child"]
1 prefix: line "group › child" selects only the child: 1 ["[p] › prefix.spec.js:3:32 › group › child"]
2 separator: line "a › b" is read as titles a, b: 0 []
2 separator: project "p › q" cannot be named: 0 []
3 trim: line with a trailing space in the title: 0 []
4 call file: helper tests match the helper file, which is not loaded: 0 []
4 call file: plus a load-only line for h1 loads h1 only: 1 ["[p] › helper.js:2:26 › from helper"]
4 call file: plus load-only lines for h1 and h2 select both: 2 ["[p] › helper.js:2:26 › from helper","[p] › helper.js:2:26 › from helper"]
4 call file: a positional file filter is ANDed with the list: 0 []
5 load-only: a spec named with a title no test has selects nothing: 0 []
5 load-only: the same line with a real title selects the test: 1 ["[p] › load.spec.js:2:1 › x"]
6 line and column are ignored: 1 ["[p] › own.spec.js:2:1 › own"]
```
