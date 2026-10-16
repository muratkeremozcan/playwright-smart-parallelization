/**
 * A consumer directory whose `@playwright/test/cli` stands in for Playwright. It lists a fixed
 * suite and, on a run, writes the shard's reporter file. The suite: `setup` (with a `teardown`
 * project) and `chromium`, which depends on `setup`; chromium has two tests.
 *
 * The listing follows the Playwright rules the harness relies on: `--project` (also the spaced,
 * variadic form) selects projects and defaults to all, `--grep` filters the selected projects, a
 * selected project with no test left is dropped, the projects it needs are listed whole unless
 * `--no-deps`, and `--repeat-each` repeats only tests of projects nobody depends on.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = `
  const fs = require('node:fs');
  const args = process.argv.slice(3);
  const dependencies = { setup: ['teardown'], chromium: ['setup', 'teardown'], teardown: [] };
  const needed = new Set(Object.values(dependencies).flat());
  const tests = [
    ['setup', 'setup.js', 'prepare'],
    ['teardown', 'teardown.js', 'clean up'],
    ['chromium', 'a.spec.js', 'works'],
    ['chromium', 'a.spec.js', 'also works'],
  ];
  if (args.includes('--list')) {
    const named = [];
    let collecting = false;
    for (const arg of args) {
      if (arg === '--project') collecting = true;
      else if (arg.startsWith('--project=')) named.push(arg.slice(10));
      else if (arg.startsWith('-')) collecting = false;
      else if (collecting) named.push(arg);
    }
    const at = args.indexOf('--grep');
    const grep = at === -1 ? '' : args[at + 1];
    const repeatArg = args.find((arg) => arg.startsWith('--repeat-each='));
    const repeat = repeatArg ? Number(repeatArg.slice(14)) : 1;
    const noDeps = args.includes('--no-deps');
    const selected = named.length ? named : Object.keys(dependencies);
    const hit = ([project, , title]) => selected.includes(project) && (!grep || title.includes(grep));
    const top = new Set(tests.filter(hit).map(([project]) => project));
    const pulled = noDeps ? [] : [...top].flatMap((project) => dependencies[project]);
    const chosen = tests.filter((test) => hit(test) || pulled.includes(test[0]));
    const specs = chosen.map(([project, file, title]) => ({
      title,
      file,
      line: 1,
      column: 1,
      tests: Array.from({ length: needed.has(project) ? 1 : repeat }, () => ({
        projectName: project,
        annotations: [],
      })),
    }));
    const projects = Object.keys(dependencies).map((name) => ({ name, testDir: '/t' }));
    process.stdout.write(JSON.stringify({
      config: { projects },
      suites: specs.map((spec) => ({ title: spec.file, file: spec.file, specs: [spec] })),
    }));
  } else {
    const leaves = [{ key: process.env.PSP_STUB_MARK || 'unmarked' }];
    fs.writeFileSync(process.env.PSP_HARNESS_RESULT, JSON.stringify({ durationMs: 5, leaves }));
    process.exit(Number(process.env.PSP_STUB_EXIT || 0));
  }
`;

/** Creates the consumer directory and returns its path. The caller removes it. */
function createStubConsumer() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-stub-playwright-'));
  const pkg = path.join(cwd, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/test' }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), CLI);
  return cwd;
}

module.exports = { createStubConsumer };
