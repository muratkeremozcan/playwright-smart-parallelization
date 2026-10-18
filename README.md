# playwright-smart-parallelization

Balances Playwright shards by past test durations, so the run stops waiting on one slow shard.

With two shards that take 10 and 15 minutes, the workflow waits for the 15.
This Action moves spec files between shards by how long they took before.
It runs in your existing jobs and keeps the timing history in your repository's GitHub Actions cache, with no other service or account.

## Usage

Needs Playwright 1.63 or later.

```yaml
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  actions: read

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
        with:
          node-version: latest
      - run: npm ci
      - run: npx playwright install --with-deps
      - uses: muratkeremozcan/playwright-smart-parallelization@v1 # or a full commit sha
      - run: npx playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }} $PSP_ARGS
```

Add the Action before your test command and append `$PSP_ARGS`, unquoted, to that command.
Your filters and shard arguments stay as they are, and an npm script works too: `npm run test:e2e -- --shard=1/4 $PSP_ARGS`.

The first run has no history, so it runs native sharding and records the durations.
Each shard on the default branch then publishes its passing tests' times, and pull requests read that history without writing it.
A cache entry unused for 7 days expires, so a quiet repository starts cold again; see [history](docs/reference.md#history) to keep suites or environments apart.

To return to plain Playwright, skip the Action step with an `if:` condition, which leaves `$PSP_ARGS` empty; finish then reports `exactly-once: not checked` and passes.
`--last-failed` needs the step skipped too.
Playwright resolves the workers from your config and command, and every shard plans for the count the history recorded.

### Optional: check that every test ran once

For a check that every selected test ran exactly once across shards, and a shard timing summary, add a job under `jobs:`:

```yaml
finish:
  needs: test
  if: ${{ always() }}
  runs-on: ubuntu-latest
  steps:
    - uses: muratkeremozcan/playwright-smart-parallelization/finish@v1 # same ref as the Action step
```

Finish reads the Action's own run records and does not merge Playwright reports, so your report upload and merge steps stay as they are.
See [finish](docs/reference.md#finish) for multiple suites or matrix dimensions.

## Results

On [pw-parallel-test](https://github.com/muratkeremozcan/pw-parallel-test): 605 sleep-only tests in 67 spec files, Playwright 1.64.1, `fullyParallel` on, the Action at `d3633df`.
Each number is a median of 3 to 6 warm runs and links to its median run.

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

Slowest shard is Playwright's test time; completion runs from the first job start to the last job end, finish included.
Shard-job machine time was higher with the Action in every layout.
All runs, cold starts and machine time are in [RESULTS.md](https://github.com/muratkeremozcan/pw-parallel-test/blob/625502a1962b3e1ddc6fb324e242586c6e003a77/RESULTS.md).

## How it works

1. Playwright loads the suite with your config and filters, and `$PSP_ARGS` adds a reporter whose `Reporter.preprocess` hook runs before any test.
2. Every shard reads the same timing snapshot, pinned for that workflow run, and runs the same deterministic planner, so all shards agree on the split.
   A unit is one spec file in one project at one repeat, kept whole even with `fullyParallel`, and Playwright still owns setup and teardown dependencies.
3. The reporter calls `TestRun.exclude()` for tests that belong to other shards and `TestRun.skipSharding()` so Playwright does not split them a second time.
4. Playwright runs the rest with its normal workers, fixtures, retries and your reporters.
5. After the job, each shard uploads its run record and, on the default branch, merges its passing samples into the history in the cache.

Large spec files limit how even the shards can get, and install, app start and runner queues still take their time, so balancing helps most when uneven test time is what holds up the run.

## Reference

- [Reference](docs/reference.md): the command, workers, outputs, finish, history and runner needs.
- [Action inputs](action.yml) and [finish inputs](finish/action.yml).
- [Design decisions](docs/decision-record.md).

## Maintaining this repo

Needs Node 22 or later, plus `zip` and `unzip`.

```sh
npm run setup
npm run validate
```

`validate` runs lint, format check, unit tests, and a check that nothing private lands in this public repo.
The harness and the release workflow are in [docs/development.md](docs/development.md).

### Releasing

1. Run **Actions → Release → Run workflow** on `main` with a bump (`patch`, `minor` or `major`; the first release uses `major`). It runs the checks and creates a draft release, or moves an existing draft to the latest `main`.
2. Open the draft link in the run summary and click **Edit**.
3. Tick **Publish this Action to the GitHub Marketplace**. On the first release, accept the agreement and pick a primary category.
4. Click **Publish release**. The workflow then verifies the release and moves the major tag (`v1`) to it.

## License and attribution

[MIT](LICENSE).
Includes MIT-licensed code adapted from Gary Parker's [playwright-shard-balancer](https://github.com/qa-gary-parker/playwright-shard-balancer).
