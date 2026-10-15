# Engine qualification

## Landscape (observed 2026-10-15, source and docs research only, nothing benchmarked)

| Dimension | Gleb free Cypress stack | Flakiness Playwright | NSXBet Playwright orchestrator |
|---|---|---|---|
| Main strength | Complete reusable CI experience | Playwright-aware grouping and setup allocation | Planning and timing CLIs plus Actions |
| Allocation | Static duration-based spec partition (longest first, least-loaded machine) | Static setup-aware partition (SALT) | Static CKK allocation with LPT fallback |
| Integration | Cypress plugin plus reusable workflow | Extra reporter, native `--shard` kept | Plan once, run native `--test-list` |
| Timing input | Compact spec timing JSON | Its local report and timing format | Standard Playwright JSON reports |
| Hosted service | No | No for local workflow | No for documented local workflow |
| Extra runtime reporting | Plugin and workflow outputs | Full additional report generation | Uses existing JSON results |
| Live redistribution | No | No | No |
| Open concern | Cypress-specific semantics | Reporting footprint, Playwright 1.62+ | Serial and dependency correctness, current Action paths, Playwright 1.56+ |

Package facts to re-resolve at implementation time: `@flakiness/playwright` MIT v2.0.2 (balanced sharding, `disableUpload`, local history builder sums retry duration per run and takes the max across runs, unknown tests default 1 second); `@nsxbet/playwright-orchestrator` MIT 2.0.0 (plan, extract-timing, EMA merge, setup/orchestrate/get-shard/extract-timing/merge-timing Actions; monorepo move left older repo names in examples). Gleb: `cypress-split` v1.25.0 MIT, `cypress-workflows` `split.yml`, `gh-build-matrix` (framework-neutral, reusable for Playwright).

Dynamic alternatives, not candidates unless static planning fails: Currents (hosted), `rostmanrk/playwright-orchestrator` (self-hosted queue, Apache-2.0, restoration of unfinished tests after termination listed as future work).

Gleb specifics worth keeping: unknown specs get the average known duration; absent history falls back to name-based split; timing updates have a change threshold; failed or empty runs are excluded from timing updates; artifacts upload always while timing merge depends on successful E2E jobs.

## Step 0: inspect the target runner

Record Playwright and Node versions, shard count, workers per shard, projects and dependencies, serial suites, `repeatEach` and retries, filters, reporters, CI runner type, artifact retention. Identify the dominant delay: uneven assignment, one oversized atomic group, or shared-environment contention. Keep existing isolation settings.

## Consumer fixture

Install the latest published packages; record the resolved versions and commit the lockfile of each run as evidence. Contents: normal files, independent parallel tests, a serial suite whose second test depends on the first, setup and teardown projects, two browser projects, duplicate titles in different files, parameterized tests, retries, `repeatEach`.

## Compatibility proofs (per engine)

1. Every selected leaf test/project/repeat combination lands in exactly one shard. Setup and dependency executions are counted separately, not as duplicates.
2. Serial groups keep execution and retry behavior. File affinity does not relax correctness.
3. Existing filters and project selection mean the same before and after.
4. Every shard uses the same commit, config, selection, and immutable timing snapshot or assignment.
5. Corrupt or mismatched input cannot split shards between native and custom assignment. Fallback is whole-run before fan-out, or fail before execution.
6. Failure exit codes, retries, traces, blob reports, and merged reports remain valid. Missing shard artifacts make aggregation incomplete, never green.
7. A run with no history executes the full intended suite. New and renamed tests are kept with visible default estimates.
8. Test failures, cancellation, and missing artifacts never replace good history with partial or zero-valued data.

Also test explicitly: one shard with a damaged timing file; two runs racing to publish history.

## Privacy and footprint gates

- Flakiness: set `disableUpload: true`, omit service credentials and project binding, build history locally rather than fetching from cloud. Verify outbound connections in the fixture; the flag alone is not an audit.
- Record added runtime, memory, disk and artifact size, package footprint. Prefer existing reporters over duplicate reporting where equivalent correctness is proven.
- Untrusted PR runs read history only; a trusted post-run process publishes.

## Measurement protocol (real suite)

Native sharding is the baseline. Hold shard count, workers, hardware, corpus, environment, retry policy fixed. Alternate baseline and candidate order across at least 5 pairs. Record end-to-end completion, per-shard durations, aggregate runner time, setup and report overhead, failures and retries, history hit rate. Separate queue delay from execution. Gate: at least 10% median completion-time reduction, no correctness regression, no material retry increase. Variability comparable to the gain means inconclusive. Paid runner-minute savings depend on billing and are not assumed.

## Decision record contents

Exact versions, fixture results per proof, raw real-run measurements, verdict (adopt, reject with reproduced reason, inconclusive), smallest remaining integration gap. Stop when an existing implementation meets the need without custom code.

## If neither engine qualifies (CAP-7)

Document the failing fixture or measured cost first. Prefer an upstream fix or a supported standalone export over a fork. A minimal Playwright Utils implementation uses `Reporter.preprocess` (receives the selected unsharded corpus before native sharding) and preserves native grouping and dependencies instead of distributing individual test titles. MIT-licensed algorithm and test material may be reused with attribution.
