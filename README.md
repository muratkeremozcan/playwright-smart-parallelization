# playwright-smart-parallelization

Balances Playwright shards by test duration, so all shards finish at about the same time.

Native `--shard` splits by test count (by file count without `fullyParallel`).
With 2 shards, one can take 10 minutes and the other 15, and the run waits for the 15.
This Action splits by past durations, kept in your repo's own Actions storage.

The Action is not ready yet: it exits with "not implemented yet".

## What we know so far

- NSXBet failed the core sharding checks; Flakiness passed them but reads a private Playwright field, so we build our own on public APIs. See the [comparison](docs/qualification/comparison.md).
- On couture-cast, about 86% of a 10 minute run is outside the test span, so balancing its 2 shards saves about 22 seconds. See the [baseline](docs/measurements/baseline.md).
- Mechanisms we take from playwright-shard-balancer are in the [harvest](docs/research/shard-balancer-harvest.md).

## Maintaining this repo

Needs Node 22 or later, plus `zip` and `unzip`.

```sh
npm run setup
npm run validate
```

`validate` runs lint, format check, unit tests, and a check that nothing private lands in this public repo.
The harness, qualification, measurement and research commands are in [docs/development.md](docs/development.md).

## License

[MIT](LICENSE)
