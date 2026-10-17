# playwright-smart-parallelization

Balances Playwright shards by test duration, so all shards finish at about the same time.

Native `--shard` splits by test count, and keeps each file whole without `fullyParallel`.
With 2 shards, one can take 10 minutes and the other 15, and the run waits for the 15.
This Action splits by past durations, kept in your repo's own Actions storage.

## Results

On [pw-parallel-test](https://github.com/muratkeremozcan/pw-parallel-test): 222 sleep-only tests, Playwright 1.64.1, 1 worker per shard, the Action at `063aba8`, medians from [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/c0623de/RESULTS.md).

| Shards           |  Slowest shard |     Completion | Machine time | Runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------: | -------------: | -----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 shards, native |        177.4 s |        213.5 s |      492.5 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38973296352) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38974030426) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38974811974) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38990554377) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38991559284) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38992617135) |
| 4 shards, Action | 110.1 s (-38%) | 160.0 s (-25%) |      514.0 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38990835836) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38991829616) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38992888743)                                                                                                                                                                                                                                                       |
| 8 shards, native |        147.9 s |        185.5 s |      563.0 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38973698179) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38974426524) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38975244150) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38991083935) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38992068791) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38993116763) |
| 8 shards, Action |  59.0 s (-60%) | 121.0 s (-35%) |      596.0 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38991381689) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38992311276) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/38993402144)                                                                                                                                                                                                                                                       |

The ideal slowest shard is 108.2 s at 4 shards and 58.0 s at 8.
The Action adds about 5 s per shard (machine time +4% and +6%), and the first run, with no history, runs native.

## Usage

Pin a commit sha until v1 is released.

Add one step before your Playwright command, and `$PSP_ARGS` at the end of it:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
      - run: npm ci && npx playwright install --with-deps chromium
      - uses: muratkeremozcan/playwright-smart-parallelization@<sha>
      - run: npx playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }} $PSP_ARGS
```

Your command stays yours: an npm script works as `npm run test:e2e -- --shard=1/4 $PSP_ARGS`, and so do shell variables, filters and a project in a subdirectory.
Each shard publishes its own test times from the default branch, so the next run balances with no extra job.

For a cross-shard check that every test ran exactly once, and the shard times in the job summary, add the finish action to the job that merges your reports:

```yaml
- uses: muratkeremozcan/playwright-smart-parallelization/finish@<sha>
```

To turn balancing off, set `enabled: false`: `$PSP_ARGS` is empty and the run is plain Playwright.

All inputs are in [`action.yml`](action.yml); outputs, the history and the runner needs are in [`docs/reference.md`](docs/reference.md).

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

To release, run **Actions → Release → Run workflow** on `main` with a bump; the first release picks `major`, which takes the `v0.0.0` baseline to `v1.0.0`.
Publish the draft it creates with **Publish this Action to the GitHub Marketplace** ticked, and the workflow moves `v1` to that release.

## License

[MIT](LICENSE)
