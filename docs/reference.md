# Reference

Facts about the Action that the README example does not need. Every input is in [`action.yml`](../action.yml) and [`finish/action.yml`](../finish/action.yml).

## The command

- `$PSP_ARGS` holds `--add-reporter=<the Action's reporter>`, plus `--workers=<n>` when the `workers` input is set. Put it last and unquoted.
- An npm script passes it through after `--`: `npm run test:e2e -- --shard=1/4 $PSP_ARGS`.
- The shard comes from your own `--shard` (or `shard` in the config). A run without one is not balanced; it is recorded as one shard.
- Playwright keeps only the last `--add-reporter`, so add your own reporters in the config, not on the command line.
- The Action exports the reporter's options as `PSP_*` variables to the later steps of the job.

## Workers

- With `workers` set, `$PSP_ARGS` passes it to Playwright and the plan packs every shard for that many workers.
- With `workers` unset, Playwright resolves the workers from the runner's CPUs and the plan packs for 1 worker per shard, so every shard plans the same on any runner.

## Outputs

- The Action outputs `mode` (`balanced`, `native` or `disabled`), `reason` and `args` (the value of `$PSP_ARGS`).
- `finish` outputs `mode`, `coverage` (`ok`, `failed` or `not checked`) and `overhead-ms`.

## Finish

- `finish` reads the run records the shards upload as `psp-record-*` artifacts, so it needs no blob reports and merges none; your own merge step stays yours.
- It checks every sharded job of the run; with several sharded jobs and a finish for each, give each job its own `history-key` and pass the same one to its finish.
- It reads the jobs API for the per-shard overhead, so its job needs `permissions: actions: read`.

## History

- The history is keyed by working directory, workers, runner label and `history-key`; the shard count and the command's filters can change freely, since each test keeps its own samples.
- Each shard publishes the samples of its passing tests, also when another test of the shard failed.
- Every shard of a job and every re-run of one plans from one snapshot, pinned in a `psp-pin-*` artifact of the workflow run, never to the checked-out commit.
- It lives in the Actions cache, which drops entries unused for 7 days, so a quiet repo starts cold again.

## Runner

- The Action runs on the runner's Node 24. The reporter runs in your Node, which Playwright 1.63 and later needs at 20 or above.
- Playwright below 1.63, an unknown Playwright version, or Yarn Plug'n'Play leave `$PSP_ARGS` empty: plain `--shard`.
- Without an Actions cache, or with a cache mode that refuses reads, every shard runs native; a cache mode that refuses reads or writes publishes nothing.
- The pin lives as long as the run's artifacts. A re-run after they expired stops before any test when earlier shards planned from the pin; start a new run.
