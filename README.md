# playwright-smart-parallelization

A GitHub Action that balances Playwright shards by test duration.

Native `--shard` splits tests by count, so one shard can finish long before another and the run
waits for the slowest. This action will assign tests to shards from historical durations kept in
the consuming repository's own Actions storage, and fall back to native sharding with one switch.

## Status

The action is a skeleton. It fails on every run with `playwright-smart-parallelization is not
implemented yet`, so a workflow that adopts it early cannot mistake a no-op for a balanced run.

## Planned inputs

All inputs are provisional and may change before the first release. See [`action.yml`](action.yml)
for the current names and defaults.

| Input                  | Default              | Purpose                                      |
| ---------------------- | -------------------- | -------------------------------------------- |
| `working-directory`    | `.`                  | Directory of the Playwright project          |
| `config-path`          | empty                | Playwright config file                       |
| `projects`             | empty                | Projects to run                              |
| `filters`              | empty                | Extra Playwright selection arguments         |
| `shard-count`          | `2`                  | Shards in the matrix                         |
| `workers`              | `1`                  | Playwright workers per shard                 |
| `timing-artifact-name` | `playwright-timings` | Artifact that stores the timing history      |
| `retention-days`       | `30`                 | Retention of uploaded artifacts              |
| `enabled`              | `true`               | `false` restores native sharding for the run |

## Development

```sh
npm ci
npm run validate
```

`validate` runs ESLint, Prettier in check mode, the unit tests (`node --test`) and
`check:public`, which fails on private home-directory paths and credential-shaped tokens because
this repository is public. `npm run format` rewrites files with Prettier.

The action has no runtime dependencies. ESLint, Prettier and `yaml` are development tools only, and
all dependencies float to their latest versions with the lockfile committed.

## Qualification harness

`fixtures/consumer` is a browser-free Playwright project with every shape a balancing engine has
to survive: setup and teardown projects, two browser projects, duplicate titles in different files,
parameterized tests, retries, serial suites (one of them oversized) and parallel suites. No test
launches a browser, so the project needs no browser download.

`harness/` is a plain Node library and CLI. Playwright answers every question about the selection:
a reporter lists the leaves (one test in one project at one repeat) in list mode and in shard
runs, so a listed key and a run key match by construction, and it records each project's
dependencies from the config. Arguments after `--` reach Playwright exactly as given, in every
spelling it accepts. The harness runs a partition shard by shard and checks that every leaf was
selected exactly once, that each selected leaf ran to a result (a leaf that skipped or never ran is
a `not-executed` violation), that no serial group was split across shards, and that each shard ran
the setup and teardown leaves its tests depend on exactly once.

One rule classifies the leaves, and Playwright supplies its input. Two more listings with the
selection, at `--repeat-each=1` and `--repeat-each=2`, show which projects are top-level: Playwright
applies the flag to the projects whose own tests `--project`, `--grep`, tag and file filters keep,
and leaves a project it only pulled in as a dependency unchanged. A project whose leaf count grows
between the two is primary. Any other listed project is a dependency, exempt from exactly-once
coverage but required in every shard that runs a project needing it. So a setup or teardown project
the filters left standing alone is primary, a dependency project that repeats because its config
says `repeatEach` is still a dependency, and `--no-deps`, whether it is a flag or the value of
another option, needs no argument handling here. The harness writes a JSON report with the
Playwright and Node versions, per-shard durations, the slowest shard and the imbalance.

The harness supports and proves these selections, each against real Playwright: `--project`,
`--grep`, `--grep-invert`, `--repeat-each`, `--no-deps`, `--config` or `-c`, file filters and
project-level config. It rejects, before any listing or run, what it cannot prove exactly-once, and
fails closed instead of qualifying a different suite:

- `--last-failed` and `--only-changed`, which select tests from state outside the command line.
- `--shard`, and a config that sets `shard`, because the engine under test owns sharding and the
  harness partitions the run itself. The reporter reports the sharding of the resolved config, and
  a listing that carries one is rejected.
- `--list`, which executes nothing.
- The `--` separator among the forwarded arguments, which hands everything after it to the tests
  and would swallow the options the harness adds.
- A focused test (`.only`) with `forbidOnly` off. Playwright lists every test but a run executes the
  focused ones only, so the harness lists with `--forbid-only` and rejects the suite.
- A project without a name, or two with one name. Playwright accepts unnamed projects, but the
  harness keys its dependency map, serial groups and `--test-list` selections by project name.
- An empty selection, even when Playwright accepts it with `--pass-with-no-tests`: a run needs at
  least one primary leaf to qualify.

Project names are user strings, so no table keyed by them is a plain object: a project named
`__proto__` keeps its leaves and its dependencies.

Playwright's `--test-list` is a lossy selector, so a suite it cannot pick out exactly is rejected
wherever the harness builds a list, which is `testListPartition` and the negative control, before
any run. The same check runs in `qualify` when a partition an engine supplies, or a forwarded
argument, hands Playwright a `--test-list` or `--test-list-invert` file, read with the option arity
of the installed Playwright from its `--help`, because a value can look like a flag. Native sharding
picks no test by title and still qualifies such a suite. The rejected shapes: a project name, file,
spec file, suite title or test title with `›`, a control character, a newline, surrounding
whitespace or an unpaired surrogate, since a list line cannot carry it; a test whose title path is a
prefix of another's in the same project and file, since its line selects both; and two different
tests with one project, call file and title path, such as the tests a helper registers for several
specs, since no line tells them apart. Each error names the leaves. The load-only line that loads a
helper's spec uses a title that no title path in the listing has. The limits and their
reproductions, on Playwright 1.56.1, 1.60.0 and 1.64.1, are in
[docs/playwright-test-list-selection-limits.md](docs/playwright-test-list-selection-limits.md).

A leaf is keyed by Playwright's own test id, which is unique per project, spec file, title path and
repeat. A key from the project, the file of the test call and the title is not: a helper that
registers tests for several spec files puts them all at one file. The key is shown to people as a
label, `project|spec file|title path|#repeat`. A serial group is the outermost serial suite of the
test, found from the suite ancestry rather than a line number, and named by the project, spec file
and suite titles rather than the call site, so sibling suites a helper builds are separate
groups. An explicit `--test-list` partition names the file of the test call, which is the helper
for a helper's tests and not a test file, so it also names each defining spec with a title no test
has: that loads the spec and selects nothing, and the specs a shard loads decide which of the
helper's tests it runs. The reporter fails closed when two tests share an id, when two distinct serial suites share
a group, or when the serial suites of a test cannot be matched exactly.

```sh
(cd fixtures/consumer && npm ci)
npm run harness -- --shards 3 --repeat-each 2
npm run harness:negative
```

`harness` accepts `--cwd`, `--config`, `--shards`, `--repeat-each`, `--workers` (default 1),
`--report` and `--negative-control`. Arguments after `--` go to both the list and the run commands.
It exits 1 on any violation.

`harness:negative` runs six clean partitions and nine deliberately broken ones. It exits 0 only if
each clean one is accepted and each broken one is rejected with the expected violation. Four broken
ones are a dropped leaf, a duplicated leaf, a split serial group, and a run where every test skips
at runtime. The other five run a selection of the setup project:

- `--project=setup`, with a run that executes only the teardown.
- Setup and a browser project selected and then filtered down to the setup test, with a run that
  executes only the teardown.
- The same filter with no project named, with the same run.
- Setup and teardown selected under `--no-deps`, with setup in every shard.
- `--grep-invert --no-deps`, where Playwright reads `--no-deps` as the pattern and keeps the
  dependencies, with the browser projects run apart from setup.

The skip run sets `PSP_FIXTURE_SKIP_ALL=1`, which makes every fixture test skip, and must flag every
primary leaf. The selection runs build their own selection and ignore the forwarded arguments,
except that `--config` applies to them. They need a suite whose setup project has a teardown project
and a project that depends on it. A suite that skips tests by design fails the `not-executed` check:
the harness has no allowance for a leaf that is meant to skip. Other engines plug in as
`{ args, env }` shards through `harness/partitions.js`.

## Engine qualification

Each candidate engine is installed from npm in its own directory with a committed lockfile and
driven through the harness: `qualification/nsxbet` for `@nsxbet/playwright-orchestrator` and
`qualification/flakiness` for `@flakiness/playwright`. Both run the same eight compatibility proofs
plus a damaged timing file and two runs racing to publish history, check that the engine makes no
outbound connection, and measure balance and footprint against native sharding. Shared code lives
in `qualification/lib`.

- [`docs/qualification/nsxbet.md`](docs/qualification/nsxbet.md) holds the NSXBet verdict, the
  resolved versions and the evidence for every row.
- [`docs/qualification/flakiness.md`](docs/qualification/flakiness.md) does the same for Flakiness.
- [`docs/qualification/comparison.md`](docs/qualification/comparison.md) puts the two side by side.

```sh
npm run qualify:install
npm run qualify:nsxbet
npm run qualify:nsxbet:test
npm run qualify:flakiness
npm run qualify:flakiness:test
```

`qualify:ENGINE` writes `qualification/ENGINE/evidence.json` (`--out FILE` picks another path).
`--group NAME` collects one group (`coverage`, `serial`, `assignment`, `history` and `privacy` for
both engines, plus `balance` for Flakiness), and `--merge FILE...` joins the evidence of the groups.
`qualify:ENGINE:test` asserts every result; with `PSP_NSX_EVIDENCE=FILE` or `PSP_FLK_EVIDENCE=FILE`
it reads an earlier evidence file instead of collecting again. The `Qualification` workflow runs
both engines on pull requests that touch `qualification/`, `harness/` or the fixture, with every
group on its own runner.

## Measurements

`measurements/` turns finished GitHub Actions runs of a Playwright workflow into the figures of
[`docs/measurements/baseline.md`](docs/measurements/baseline.md), the before measurement of
couture-cast.

- `collect.js` reads one finished run through `gh api` (the run, every job with its steps, the
  runner image from each job log, and one blob report per shard) and writes
  `docs/measurements/raw/LABEL-RUNID.json`. It pages through every list, checks the counts the API
  reports, and records a shard whose blob report is missing or expired with the reason. A blob report
  holds the whole environment of the web server, so `blob.js` copies only the fields it reads and
  never the environment.
- `analyze.js` and `render.js` compute everything in the document from those records. The document
  is generated whole and a test compares it with the committed file, so a figure cannot drift from
  its evidence.
- `couture-cast.json` names the target: the repository, the shard job and artifact names, the
  step that runs the tests and the serial suites Playwright keeps whole.

```sh
npm run measurements:collect -- --label baseline-a --pair 1 --run RUN_ID
npm run measurements:report
```

`gh` (logged in), `unzip` and, for the unit tests, `zip` must be on the `PATH`. Blob artifacts expire after the workflow's retention (five days for couture-cast), so collect a run
before then.

## License

[MIT](LICENSE)
