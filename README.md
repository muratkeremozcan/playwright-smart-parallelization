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

`harness/` is a plain Node library and CLI. It lists the leaves a run is meant to cover (one test
in one project at one repeat), runs a partition shard by shard, and checks that every leaf was
selected exactly once, that each selected leaf ran to a result (a leaf that skipped or never ran is
a `not-executed` violation), that no serial group was split across shards, and that each shard ran
the setup and teardown leaves its tests depend on exactly once. A setup or teardown project that
`--project` selects by name, and that no other selected project with tests left needs, is a project
under test: its leaves get the exactly-once check too. Under `--no-deps` there are no dependencies,
so every selected leaf is primary. It writes a JSON report with the Playwright and Node
versions, per-shard durations, the slowest shard and the imbalance.

```sh
(cd fixtures/consumer && npm ci)
npm run harness -- --shards 3 --repeat-each 2
npm run harness:negative
```

`harness` accepts `--cwd`, `--shards`, `--repeat-each`, `--workers` (default 1), `--report` and
`--negative-control`. Arguments after `--` go to both the list and the run commands. It exits 1 on
any violation. `harness:negative` runs four clean partitions and seven deliberately broken ones and exits 0 only if
each clean one is accepted and each broken one is rejected with the expected violation. The broken
ones are a dropped leaf, a duplicated leaf, a split serial group, a run where every test skips at
runtime, and three runs that execute only the teardown or run setup in every shard: with
`--project=setup`, with setup and a browser project selected and then filtered down to the setup
test, and with setup and teardown selected under `--no-deps`. The skip run sets
`PSP_FIXTURE_SKIP_ALL=1`, which makes every fixture test skip, and must flag every primary leaf.
The selection runs drop the other forwarded arguments except the config selection, and they need a
suite whose setup project has a teardown project and a project that depends on it. A suite that
skips tests by design fails the `not-executed` check: the harness has no allowance for a leaf that
is meant to skip. Other engines plug in as `{ args, env }` shards through `harness/partitions.js`.

## License

[MIT](LICENSE)
