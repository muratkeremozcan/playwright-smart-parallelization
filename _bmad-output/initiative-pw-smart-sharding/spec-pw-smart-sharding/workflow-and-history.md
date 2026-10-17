# Workflow and history

CAP-3 chose our own engine (CAP-7). The loop below is the one built; `action.yml`, `finish/action.yml` and `docs/reference.md` hold the exact interface.

## The Action loop

- **Inputs:** enabled, workers, working directory, runner label, history key, publish policy. The command, config, projects, filters and shard count stay in the caller's own Playwright command.
- **Main step**, in each shard job before the caller's command: upload a start marker, pin one history snapshot to the job and run, decide the mode from its bytes, export `$PSP_ARGS`. Keep the caller's own dependency install and app start steps.
- **Execute:** the caller's ordinary Playwright command with `$PSP_ARGS`; the bundled reporter balances whole spec files and writes the shard's record. `--no-deps` makes every project ordinary; `--last-failed` is refused before any test.
- **Post step:** upload the shard's record, uniquely named per job, suite, shard and attempt, even when tests fail, and publish the shard's passing samples by compare-and-swap.
- **Finish (optional):** prove exactly-once coverage across the shards, including re-run shards that left no record, and summarize slowest-shard time and imbalance. Report merging stays the caller's.
- **Rollback:** a single switch disables balancing for the entire run and keeps existing native reporting.

## History policy

- Every trusted shard publishes its own samples by compare-and-swap. Each record carries source commit and run, configuration fingerprint, schema version, and time.
- A delayed older run never overwrites newer history.
- Observations for tests absent from a filtered run are preserved.
- A failed shard publishes the samples of its passing tests; failed attempts, cancelled runs and zero-valued data never replace good history.
- Bounded observation window, with a review that history adapts after tests get faster. No endless max-over-history accumulation.
- Separate history per working directory, explicit worker count, runner class and `history-key`; callers separate browsers and environments with `history-key`.
- Reuse the engine's format and merger first. Change policy only when measurements show a problem.
- Persist in the consuming repo's own Actions storage (artifact or cache); the simplest option that works.

## Deliverables beyond code

Documentation of cold start, refresh, diagnostics (imbalance summary), and rollback.
