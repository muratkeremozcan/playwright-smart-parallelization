# Development

How to set up this repository, check it, run the harness and release the Action.

## Setup

Needs Node 22 or later, plus `zip` and `unzip`.

```sh
npm run setup
npm run validate
```

`setup` runs `npm ci` in the root and in `fixtures/consumer`, the same installs CI runs.
`validate` runs ESLint, Prettier in check mode, the unit tests (`node --test`) and `check:public`.
The unit tests include `tests/dist.test.js`, which fails when the committed `dist/` differs from a fresh `npm run build`.
`npm test` loads `tests/support/temp.js`, so each test process and every process it starts make their temporary folders under one folder that is removed when the process exits.
`check:public` fails on private home-directory paths and credential-shaped tokens, because this repository is public.
`npm run format` rewrites files with Prettier.

The Action is a JavaScript action, and `npm run build` bundles it with esbuild into `dist/`, which is committed, so a user installs nothing.
Its runtime dependencies are the official `@actions/core`, `@actions/cache` and `@actions/artifact` toolkit, pinned exactly.
`dist/reporter.js` is the reporter `$PSP_ARGS` adds to the user's command; it runs in the user's Node and bundles no toolkit.
Run `npm run build` after any change to `lib/`, `src/` or `reporter/`, and commit `dist/` with it.
ESLint, Prettier, esbuild and `yaml` are development tools only.
The lockfile is committed.

## Qualification harness

`fixtures/consumer` is a browser-free Playwright project with every shape a balancing engine has to survive.
It has setup and teardown projects, two browser projects, duplicate titles in different files, parameterized tests, retries, serial suites (one of them oversized) and parallel suites.
No test launches a browser, so the project needs no browser download.

`harness/` is a plain Node library and CLI.
Playwright answers every question about the selection.
A reporter lists the leaves (one test in one project at one repeat) in list mode and in shard runs, so a listed key and a run key match by construction.
The reporter also records each project's dependencies from the config.
Arguments after `--` reach Playwright exactly as given, in every spelling it accepts.

The harness runs a partition shard by shard and checks four things:

- Every leaf was selected exactly once.
- Each selected leaf ran to a result. A leaf that skipped or never ran is a `not-executed` violation.
- No serial group was split across shards.
- Each shard ran the setup and teardown leaves its tests depend on exactly once.

The harness writes a JSON report with the Playwright and Node versions, per-shard durations, the slowest shard and the imbalance.

### Classifying leaves

One rule classifies the leaves, and Playwright supplies its input.
Two more listings with the selection, at `--repeat-each=1` and `--repeat-each=2`, show which projects are top-level.
Playwright applies the flag to the projects whose own tests `--project`, `--grep`, tag and file filters keep.
It leaves a project it only pulled in as a dependency unchanged.
A project whose leaf count grows between the two listings is primary.
Any other listed project is a dependency.
A dependency is exempt from exactly-once coverage, and every shard that runs a project needing it must run it.

So a setup or teardown project the filters left standing alone is primary.
A dependency project that repeats because its config says `repeatEach` is still a dependency.
`--no-deps`, whether it is a flag or the value of another option, needs no argument handling here.

### Supported and rejected selections

The harness supports and proves these selections, each against real Playwright: `--project`, `--grep`, `--grep-invert`, `--repeat-each`, `--no-deps`, `--config` or `-c`, file filters and project-level config.
It fails closed on what it cannot prove exactly-once, and rejects it before any listing or run:

- `--last-failed` and `--only-changed`, which select tests from state outside the command line.
- `--shard`, and a config that sets `shard`, because the engine under test owns sharding and the harness partitions the run itself.
  The reporter reports the sharding of the resolved config, and a listing that carries one is rejected.
- `--list`, which executes nothing.
- The `--` separator among the forwarded arguments.
  It hands everything after it to the tests and would swallow the options the harness adds.
- A focused test (`.only`) with `forbidOnly` off.
  Playwright lists every test, and a run executes the focused ones only, so the harness lists with `--forbid-only` and rejects the suite.
- A project without a name, or two with one name.
  Playwright accepts unnamed projects, and the harness keys its dependency map, serial groups and `--test-list` selections by project name.
- An empty selection, even when Playwright accepts it with `--pass-with-no-tests`.
  A run needs at least one primary leaf to qualify.

The harness reads the forwarded arguments with the option arity of the installed Playwright, from its `--help`, because a value can look like a flag.
So `--grep-invert --list` gives `--grep-invert` the pattern `--list`, and the harness accepts it as Playwright does.
`--grep --` is a pattern too, and only a separator that no option consumes is rejected.

Project names are user strings, so no table keyed by them is a plain object.
A project named `__proto__` keeps its leaves and its dependencies.

### Limits of `--test-list`

Playwright's `--test-list` is a lossy selector.
A suite it cannot pick out exactly is rejected wherever the harness builds a list, which is `testListPartition` and the negative control, before any run.
The same check runs in `qualify` when a partition an engine supplies, or a forwarded argument, hands Playwright a `--test-list` or `--test-list-invert` file.
That file is found with the same option arity.
Native sharding picks no test by title and still qualifies such a suite.

The rejected shapes:

- A project name, file, spec file, suite title or test title with `›`, a control character, a newline, surrounding whitespace or an unpaired surrogate, since a list line cannot carry it.
- A test whose title path is a prefix of another's in the same project and file, since its line selects both.
- Two different tests with one project, call file and title path, such as the tests a helper registers for several specs, since no line tells them apart.

Each error names the leaves.
The load-only line that loads a helper's spec uses a title that no title path in the listing has.
The limits and their reproductions, on Playwright 1.56.1, 1.60.0 and 1.64.1, are in [playwright-test-list-selection-limits.md](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/playwright-test-list-selection-limits.md), as of the last commit that has it.

### Leaf keys and serial groups

A leaf is keyed by Playwright's own test id, which is unique per project, spec file, title path and repeat.
A key from the project, the file of the test call and the title would collide: a helper that registers tests for several spec files puts them all at one file.
The key is shown to people as a label, `project|spec file|title path|#repeat`.

A serial group is the outermost serial suite of the test, found from the suite ancestry.
It is named by the project, spec file and suite titles, so sibling suites a helper builds are separate groups.
Line numbers and call sites play no part in either.

An explicit `--test-list` partition names the file of the test call, which for a helper's tests is the helper.
So it also names each defining spec with a title no test has.
That line loads the spec and selects nothing, and the specs a shard loads decide which of the helper's tests it runs.
The reporter fails closed when two tests share an id, when two distinct serial suites share a group, or when the serial suites of a test cannot be matched exactly.

### Running the harness

`npm run setup` installs the fixture.

```sh
npm run harness -- --shards 3 --repeat-each 2
npm run harness:negative
```

`harness` accepts `--cwd`, `--config`, `--shards`, `--repeat-each`, `--workers` (default 1), `--report` and `--negative-control`.
Arguments after `--` go to both the list and the run commands.
It exits 1 on any violation.

`harness:negative` runs six clean partitions and nine deliberately broken ones.
It exits 0 only if each clean one is accepted and each broken one is rejected with the expected violation.
Four broken ones are a dropped leaf, a duplicated leaf, a split serial group, and a run where every test skips at runtime.
The other five run a selection of the setup project:

- `--project=setup`, with a run that executes only the teardown.
- Setup and a browser project selected and then filtered down to the setup test, with a run that executes only the teardown.
- The same filter with no project named, with the same run.
- Setup and teardown selected under `--no-deps`, with setup in every shard.
- `--grep-invert --no-deps`, where Playwright reads `--no-deps` as the pattern and keeps the dependencies, with the browser projects run apart from setup.

The skip run sets `PSP_FIXTURE_SKIP_ALL=1`, which makes every fixture test skip, and must flag every primary leaf.
The selection runs build their own selection and ignore the forwarded arguments, except that `--config` applies to them.
They need a suite whose setup project has a teardown project and a project that depends on it.
A suite that skips tests by design fails the `not-executed` check, because the harness has no allowance for a leaf that is meant to skip.
Other engines plug in as `{ args, env }` shards through `harness/partitions.js`.

## Releasing

The steps are in the [README](../README.md#releasing).
The `Release` workflow runs `npm run setup`, `npm run validate` and a smoke of the Action from the checkout before it drafts a release, and again on the published tag before it moves the major tag.
`tests/release-workflow.test.js` checks its guards and runs its promote steps against a mocked API.
