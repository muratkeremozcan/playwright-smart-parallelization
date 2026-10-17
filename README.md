# playwright-smart-parallelization

Balances Playwright shards by test duration, so all shards finish at about the same time.

Native `--shard` splits by test count, and keeps each file whole without `fullyParallel`.
With 2 shards, one can take 10 minutes and the other 15, and the run waits for the 15.
This Action splits by past durations, kept in your repo's own Actions storage.

## Usage

Pin a commit sha until v1 is released.

```yaml
permissions:
  contents: read
  actions: read # finish reads the shard jobs to measure their overhead

jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.psp.outputs.matrix }}
      plan: ${{ steps.psp.outputs.plan }}
    steps:
      - uses: actions/checkout@v7
      - id: psp
        uses: muratkeremozcan/playwright-smart-parallelization@<sha>
        with:
          phase: prepare
          shards: 4
          command: npx playwright test

  test:
    needs: prepare
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
      - run: npm ci && npx playwright install --with-deps chromium # drop the install for a browser-free suite
      - uses: muratkeremozcan/playwright-smart-parallelization@<sha>
        with:
          phase: run
          plan: ${{ needs.prepare.outputs.plan }}
          shard: ${{ matrix.shard }}

  finish:
    needs: [prepare, test]
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: muratkeremozcan/playwright-smart-parallelization@<sha>
        with:
          phase: finish
          plan: ${{ needs.prepare.outputs.plan }}
```

`finish` merges the shard reports, fails if any test ran twice or not at all, updates the history, and writes the shard times to the job summary.

With the default `publish-history: auto`, only runs on the default branch write the history; pull requests, other branches and forks read it.

Playwright below 1.63 runs plain `--shard` with no coverage check.

To turn balancing off, set `enabled: false` on `prepare`.
The run goes back to plain `--shard`, and `finish` checks only the shard exit codes.

All inputs are in [`action.yml`](action.yml); outputs, report names, the history key and the runner needs are in [`docs/reference.md`](docs/reference.md).

## What we know so far

- NSXBet failed the core sharding checks; Flakiness passed them but reads a private Playwright field, so we build our own on public APIs. See the [comparison](docs/qualification/comparison.md).
- On couture-cast, about 86% of a 10 minute run is outside the test span, so perfectly balancing its 2 shards would save at most about 22 seconds. See the [baseline](docs/measurements/baseline.md).
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
