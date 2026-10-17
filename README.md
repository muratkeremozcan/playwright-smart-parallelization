# playwright-smart-parallelization

Balances Playwright shards by test duration, so all shards finish at about the same time.

Native `--shard` splits by test count, and keeps each file whole without `fullyParallel`.
With 2 shards, one can take 10 minutes and the other 15, and the run waits for the 15.
This Action splits by past durations, kept in your repo's own Actions storage.

## Results

On [pw-parallel-test](https://github.com/muratkeremozcan/pw-parallel-test): 605 sleep-only tests in 67 spec files, Playwright 1.64.1, `fullyParallel` off, medians of the Action at `410e55d` from [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/a0c5d7c3af83bf2a8c16120f9069b14cb136815f/RESULTS.md).

| Shards × workers | Slowest shard |     Completion | Shard-job machine time | Ideal slowest shard | Runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------: | -------------: | ---------------------: | ------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 × 2, native    |        95.2 s |        134.0 s |                347.5 s |              69.5 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39033285485) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39033653569) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39034054221) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39043679173) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39044142851) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39044617236) |
| 4 × 2, Action    | 72.2 s (-24%) | 116.0 s (-13%) |                365.0 s |              69.5 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39043929767) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39044396758) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39044876948)                                                                                                                                                                                                                                                       |
| 4 × 4, native    |        54.5 s |         89.0 s |                222.0 s |              36.2 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39034593825) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39034906293) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39035255615) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39045281253) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39045661226) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39046035284) |
| 4 × 4, Action    | 39.3 s (-28%) |   86.0 s (-3%) |                225.0 s |              36.2 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39045476432) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39045847674) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39046226794)                                                                                                                                                                                                                                                       |
| 8 × 2, native    |        56.6 s |         96.0 s |                428.5 s |              36.2 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39035788712) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39036151943) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39036517724) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39046639694) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39047058947) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39047434132) |
| 8 × 2, Action    | 39.0 s (-31%) |  86.0 s (-10%) |                448.0 s |              36.2 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39046872550) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39047248457) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39047634398)                                                                                                                                                                                                                                                       |
| 8 × 4, native    |        36.0 s |         76.0 s |                305.0 s |              19.6 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39036982159) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39037284603) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39037599876) [4](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39048025460) [5](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39048416368) [6](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39048814522) |
| 8 × 4, Action    | 22.9 s (-36%) |   74.0 s (-3%) |                309.0 s |              19.6 s | [1](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39048219057) [2](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39048616493) [3](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39049015500)                                                                                                                                                                                                                                                       |

With `fullyParallel` on at 4 shards, the Action at `c439738` kept whole spec files and gave a slowest shard of 72.3 s against native's 94.5 s at 2 workers, and 40.2 s against 50.3 s at 4, with completion -4% and +1%.
Each arm's cold run, and the 1-worker runs on the earlier 222-test suite, are in [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/a0c5d7c3af83bf2a8c16120f9069b14cb136815f/RESULTS.md).

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
