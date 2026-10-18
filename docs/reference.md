# Reference

Facts about the Action that the README example does not need. Every input is in [`action.yml`](../action.yml) and [`finish/action.yml`](../finish/action.yml).

## The command

- `$PSP_ARGS` holds `--add-reporter=<the Action's reporter>`. Put it last and unquoted.
- An npm script passes it through after `--`: `npm run test:e2e -- --shard=1/4 $PSP_ARGS`.
- The shard comes from your own `--shard` (or `shard` in the config). A run without one is not balanced; it is recorded as one shard.
- Playwright keeps only the last `--add-reporter`, so add your own reporters in the config, not on the command line.
- The Action exports the reporter's options as `PSP_*` variables to the later steps of the job.
- Under `--no-deps`, setup and teardown projects are ordinary projects, so the split shares their tests out like any other.
- `--last-failed` stops every shard before any test: Playwright applies it after the split, so no shard can prove what the run selected. Skip the Action's step for that command with an `if:`, which leaves `$PSP_ARGS` empty; a `finish` after it reports `exactly-once: not checked` and passes, since no shard of the run ran the step.

## The plan

- A unit is one spec file of one project at one repeat, also under `fullyParallel`. A fully parallel file stays on one shard, where native `--shard` can split it, so measure such a suite before you adopt.

## Workers

- The workers are Playwright's: your config, `--workers` on your command and the runner's CPUs decide them, and the Action changes nothing.
- Each shard publishes the count it resolved with its samples, and every shard plans for the count of the pinned snapshot, so all shards plan one split even when a percentage resolves differently on runners with other CPUs.
- A shard whose Playwright resolved another count logs one line naming both and keeps the plan; Playwright runs it with its own count. After a change of workers, the first run plans for the old count and the next for the new one.

## Outputs

- The Action outputs `mode` (`balanced`, `native` or `disabled`), `reason` and `args` (the value of `$PSP_ARGS`).
- `finish` outputs `mode`, `exactly-once` (`ok`, `failed` or `not checked`) and `overhead-ms`.

## Finish

- Only `finish` proves that every test ran exactly once across the shards; without it the run still balances, and each shard job's own status stays yours to check.
- Each shard's main step uploads a `psp-start-*` marker. A shard job that started and left no record (Playwright stopped before it loaded the reporter, the job was cancelled, or the upload failed) fails `finish`, so an earlier attempt's record never stands for a shard that was re-run. A shard whose marker cannot be uploaded after three retries stops before your command, so its job is red; `finish` cannot see a job that never uploaded its marker.
- `finish` reads the run records the shards upload as `psp-record-*` artifacts, so it needs no blob reports and merges none; your own merge step stays yours.
- It checks every sharded job of the run; with several sharded jobs and a finish for each, give each job its own `history-key` and pass the same one to its finish.
- A matrix with another dimension next to `shard` that runs the same tests, such as `node: [20, 22]`, needs its own `history-key` per leg, such as `history-key: node-${{ matrix.node }}`, so each leg keeps its own records and history.
- A run in which no shard ran the Action's step, because an `if:` skipped it, leaves `finish` nothing to check: it reports `mode: disabled` and `exactly-once: not checked` and passes. A shard job that ran the step and left no record still fails it.
- It reads the jobs API for the per-shard overhead, so its job needs `permissions: actions: read`.

## History

- The history is keyed by working directory and `history-key`; the shard count, the workers and the command's filters can change freely, since each test keeps its own samples.
- Nothing else separates it: the runner, config path, browser options under one project name, environment and Playwright version share the history, so the shards of one job plan from one pin even on runners of other operating systems or architectures. Give materially different setups their own `history-key`, such as `history-key: ${{ matrix.os }}` for a matrix of operating systems.
- Each shard publishes the samples of its passing tests, also when another test of the shard failed; a failed attempt adds no sample.
- Every shard of a job and every re-run of one plans from one snapshot, pinned in a `psp-pin-v2-*` cache entry of the workflow run, never to the checked-out commit. Each shard's run record keeps a copy, so a re-run plans the same after the cache dropped the pin.
- It lives in the Actions cache, which drops entries unused for 7 days, so a quiet repo starts cold again.

## Runner

- The Action runs on the runner's Node 24, so a self-hosted runner needs Actions runner v2.327.1 or later; installing Node 24 in the job does not upgrade the runner. The reporter runs in your Node, which Playwright 1.63 and later needs at 20 or above.
- Playwright below 1.63, an unknown Playwright version, or Yarn Plug'n'Play leave `$PSP_ARGS` empty: plain `--shard`. The version is read from `working-directory` up, else the lowest of the projects under the workspace, so set `working-directory` only when the workspace holds several Playwright versions.
- The shards of one job share one pin on any mix of Linux, macOS and Windows runners that all have `zstd`; a self-hosted Windows runner also needs GNU tar on its `PATH`, as the Actions cache requires for cross-OS archives. The cache keeps zstd and gzip archives apart, so a job split across them sees two pins and fails `finish`.
- Without an Actions cache, or with a cache mode that refuses reads or writes, no snapshot can be pinned, so every shard runs native and publishes nothing.
- A shard whose pin the cache dropped plans from the copy in the run records of the shards that already ran. With artifacts kept under 30 days, the time a run can be re-run, a re-run that finds neither and is older than the retention stops before any test; start a new run. The Action reads the run's age with `github-token`, which needs `actions: read`.
