# playwright-smart-parallelization

Balances Playwright shards by test duration, so all shards finish at about the same time.

Native `--shard` splits by test count, and keeps each file whole without `fullyParallel`.
With 2 shards, one can take 10 minutes and the other 15, and the run waits for the 15.
This Action splits by past durations, kept in your repo's own Actions storage.

## Results

On [pw-parallel-test](https://github.com/muratkeremozcan/pw-parallel-test): 605 sleep-only tests in 67 spec files, Playwright 1.64.1, `fullyParallel` on, 2 or 4 workers per shard as each row shows, the Action at `d3633df`.
Each number is a median of 3 to 6 runs from [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/130dd6a87a545ec30467c34d21792886d9d40410/RESULTS.md).

### Slowest shard, 4 shards

| Workers | Native | Action | Change |
| ------: | -----: | -----: | -----: |
|       2 | 94.4 s | 72.3 s |   -23% |
|       4 | 49.9 s | 39.4 s |   -21% |

Runs: 2 workers native [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39038131666) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39038583561) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39039050334) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39073883756) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074246670) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074651900), Action [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074087361) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074452380) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074851613); 4 workers native [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39039679822) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39040054874) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39040426542) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39075271095) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39075669166) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076154629), Action [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39075477172) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076034202) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076276512).

### Slowest shard, 8 shards

| Workers | Native | Action | Change |
| ------: | -----: | -----: | -----: |
|       2 | 55.6 s | 39.1 s |   -30% |
|       4 | 31.0 s | 26.9 s |   -13% |

Runs: 2 workers native [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076564278) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076852631) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077261131), Action [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076694533) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077014625) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077403397); 4 workers native [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077670604) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077935689) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078207777) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078550206) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078834954) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39079112300), Action [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077800664) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078074920) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078346592) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078693880) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078975350) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39079242976).

### Whole-run completion

| Shards × workers |  Native |  Action | Change |
| ---------------- | ------: | ------: | -----: |
| 4 × 2            | 134.5 s | 122.0 s |    -9% |
| 4 × 4            |  95.5 s |  86.0 s |   -10% |
| 8 × 2            |  94.0 s |  92.0 s |    -2% |
| 8 × 4            |  68.0 s |  74.0 s |    +9% |

Completion runs from the first job start to the last job end of the same runs, with the Action's finish step.
At 8 × 4 the suite is short: the Action keeps whole spec files as units under `fullyParallel` while native splits by test, and its steps add about 2 to 4 s per shard, so completion is 9% slower.

The first experiment ran with `fullyParallel` off, where whole files are the unit for both native and the Action, which made it simpler to read.
There the Action at `410e55d` cut the slowest shard by 24% to 36% and completion by 3% to 13% at the same four layouts ([RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/130dd6a87a545ec30467c34d21792886d9d40410/RESULTS.md)).
The 1-worker runs on an earlier 222-test suite are under History in [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/130dd6a87a545ec30467c34d21792886d9d40410/RESULTS.md).

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

Any Playwright command works: an npm script as `npm run test:e2e -- --shard=1/4 $PSP_ARGS`, shell variables, filters and a project in a subdirectory.
Each shard publishes its own test times from the default branch, so the next run balances with no extra job.

For a cross-shard check that every test ran exactly once, and the shard times in the job summary, add the finish action to the job that merges your reports:

```yaml
- uses: muratkeremozcan/playwright-smart-parallelization/finish@<sha>
```

To turn balancing off, set `enabled: false`: `$PSP_ARGS` is empty and the run is plain Playwright.

All inputs are in [`action.yml`](action.yml); whole-file units, keeping histories apart, outputs and the runner needs are in [`docs/reference.md`](docs/reference.md).

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
