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

## License

[MIT](LICENSE)
