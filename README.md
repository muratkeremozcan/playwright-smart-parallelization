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
project-level config. It rejects, before any listing or run, the flags that make the selection
depend on state outside the command line or on sharding, which the engine under test owns, and the
flag that runs nothing: `--last-failed`, `--only-changed`, `--shard` and `--list`. A selection that
depends on external state cannot be proved exactly-once, so the harness fails closed instead of
qualifying a different suite.

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

## License

[MIT](LICENSE)
