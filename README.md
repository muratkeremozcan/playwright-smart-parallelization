# playwright-smart-parallelization

Balances Playwright shards by test duration, so all shards finish at about the same time.

Native `--shard` splits by test count, and keeps each file whole without `fullyParallel`.
With 2 shards, one can take 10 minutes and the other 15, and the run waits for the 15.
This Action splits by past durations, kept in your repo's own Actions storage.

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

Your own `playwright test` command works as it is: an npm script as `npm run test:e2e -- --shard=1/4 $PSP_ARGS`, shell variables, filters and a project in a subdirectory.
A command with `--last-failed` needs `enabled: false`; see [`docs/reference.md`](docs/reference.md).
Each shard publishes its own test times from the default branch, so the next run balances with no extra job.

For a cross-shard check that every test ran exactly once, and the shard times in the job summary, add the finish action to the job that merges your reports:

```yaml
- uses: muratkeremozcan/playwright-smart-parallelization/finish@<sha>
```

To turn balancing off, set `enabled: false`: `$PSP_ARGS` is empty and the run is plain Playwright.

All inputs are in [`action.yml`](action.yml); whole-file units, keeping histories apart, outputs and the runner needs are in [`docs/reference.md`](docs/reference.md).

## Results

On [pw-parallel-test](https://github.com/muratkeremozcan/pw-parallel-test): 605 sleep-only tests in 67 spec files, Playwright 1.64.1, `fullyParallel` on, 2 or 4 workers per shard as each row shows, the Action at `d3633df`.
Each number is a median of 3 to 6 runs and links to its median run.

### Slowest shard, 4 shards

| Workers |                                                                                 Native |                                                                                 Action | Change |
| ------: | -------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------: | -----: |
|       2 | [94.4 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39039050334) | [72.3 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074851613) |   -23% |
|       4 | [49.9 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39040054874) | [39.4 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076034202) |   -21% |

### Slowest shard, 8 shards

| Workers |                                                                                 Native |                                                                                 Action | Change |
| ------: | -------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------: | -----: |
|       2 | [55.6 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076564278) | [39.1 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077014625) |   -30% |
|       4 | [31.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078207777) | [26.9 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39078074920) |   -13% |

### Whole-run completion

| Shards × workers |                                                                                  Native |                                                                                  Action | Change |
| ---------------- | --------------------------------------------------------------------------------------: | --------------------------------------------------------------------------------------: | -----: |
| 4 × 2            | [134.5 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074651900) | [122.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39074851613) |    -9% |
| 4 × 4            |  [95.5 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39039679822) |  [86.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076034202) |   -10% |
| 8 × 2            |  [94.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076564278) |  [92.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39076694533) |    -2% |
| 8 × 4            |  [68.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39079112300) |  [74.0 s](https://github.com/muratkeremozcan/pw-parallel-test/actions/runs/39077800664) |    +9% |

All runs and other layouts: [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/625502a1962b3e1ddc6fb324e242586c6e003a77/RESULTS.md).

## Maintaining this repo

Needs Node 22 or later, plus `zip` and `unzip`.

```sh
npm run setup
npm run validate
```

`validate` runs lint, format check, unit tests, and a check that nothing private lands in this public repo.
The harness, qualification, measurement and research commands are in [docs/development.md](docs/development.md).

### Releasing

1. Run **Actions → Release → Run workflow** on `main` with a bump (`patch`, `minor` or `major`; the first release uses `major`). It runs the checks and creates a draft release, or moves an existing draft to the latest `main`.
2. Open the draft link in the run summary and click **Edit**.
3. Tick **Publish this Action to the GitHub Marketplace**. On the first release, accept the agreement and pick a primary category.
4. Click **Publish release**. The workflow then verifies the release and moves the major tag (`v1`) to it.

## License

[MIT](LICENSE)
