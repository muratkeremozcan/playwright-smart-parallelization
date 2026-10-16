---
id: SPEC-pw-smart-sharding
companions: [engine-qualification.md, workflow-and-history.md]
sources: [../inputs/playwright-smart-sharding-comparison-and-handoff.md]
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability. Consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Playwright smart sharding

## Why

A pain to solve. Native Playwright `--shard` splits tests by count, so shards finish at very different times (10 and 15 minutes in the observed case) and the run takes the slowest. Balanced by duration the same work could approach 12.5 minutes, a 16.7% cut that is an ideal bound and depends on indivisible groups, setup cost, contention, and runner speed. Gleb Bahmutov's `cypress-split` plus `cypress-workflows` give Cypress a complete free experience (duration-based split, matrix, artifacts, timing merge). Playwright has allocators (Flakiness, NSXBet) but no equivalent turnkey workflow. The owner is Murat; local agents build it.

## Capabilities

- **CAP-1**
  - **intent:** Qualify each candidate engine (`@flakiness/playwright`, `@nsxbet/playwright-orchestrator`) against Playwright semantics using a consumer fixture installed from published packages.
  - **success:** For each engine, every proof in `engine-qualification.md` section "Compatibility proofs" has a recorded pass or reproduced fail, with exact package versions and a lockfile.
- **CAP-2**
  - **intent:** Measure each qualified engine against native sharding on one representative real suite.
  - **success:** At least 5 matched, alternating-order pairs with shard count, workers, hardware, corpus, environment, and retry policy held fixed; raw per-shard and end-to-end timings recorded; queue delay separated from execution.
- **CAP-3**
  - **intent:** Decide adopt, reject, or inconclusive from CAP-1 and CAP-2 evidence.
  - **success:** A short decision record names exact versions, fixture results, real-run measurements, the chosen engine or none, and the smallest remaining integration gap. Adopt requires at least 10% median completion-time reduction, no correctness regression, no material retry increase.
- **CAP-4**
  - **intent:** A maintainer adds duration-balanced sharding to an existing Playwright GitHub Actions pipeline through a reusable workflow around the selected engine, with the Gleb-style loop: prepare, matrix execute, artifacts, aggregate, history update, rollback.
  - **success:** On a fixture repo, a cold start (no history) runs the full suite, a second run consumes history from the first, a failed run still uploads artifacts, and the one-switch rollback restores native sharding for the entire run. Interface and behavior in `workflow-and-history.md`.
- **CAP-5**
  - **intent:** Timing history stays correct under failure and concurrency.
  - **success:** Tests demonstrate that a damaged timing file, a cancelled or failed run, a missing shard artifact, and two runs racing to publish never replace good history with partial, zero-valued, or older data, and never let some shards use custom assignment while others use native.
- **CAP-6**
  - **intent:** Operate without any third-party service.
  - **success:** Timings and reports live only in the consuming repo's own Actions artifacts or cache; a fixture network check shows no outbound connection to an engine vendor service; untrusted PR runs have read-only history access and a trusted post-run job publishes updates.
- **CAP-7**
  - **intent:** If neither engine qualifies, fill the gap with a minimal Playwright Utils implementation on the public `Reporter.preprocess` / `TestRun` API.
  - **success:** Starts only after CAP-3 records the failing fixture or measured cost; preserves native grouping and dependencies; passes the same CAP-1 proofs; uses no Playwright internals.

## Constraints

- No speedup by skipping work: no fewer tests, dropped browser projects, changed retries, `fullyParallel` enabled for the benchmark, or larger runners.
- Serial groups, setup/teardown dependencies, filters, and project selection keep identical meaning before and after adoption. File affinity never stands in for serial correctness.
- Every shard of a run uses one commit, config, selection, and immutable timing snapshot or assignment. Fallback to native sharding is decided for the whole run before fan-out, otherwise the run fails before execution.
- Missing or corrupt shard artifacts or timing input never yield a green or silently partial result.
- Allocation is static, preassigned from historical durations. Live redistribution and queue infrastructure are out of scope unless static planning is shown insufficient.
- No dependency on undocumented deep imports (Flakiness exports only its reporter) and no patching of Playwright internals.
- Durations from different browsers, runner classes, worker counts, or materially different environments are never mixed without justified normalization.
- Flakiness with `disableUpload: true` still generates reports and samples CPU/RAM. Treat it as heavier than timing-only until measured.
- The `cypress-split` pairwise-averaging merger is order-dependent for three or more observations and is not transplanted. History uses a bounded observation window.
- Timing data stays in the consuming repo's own Actions storage; no third-party service or gist. Untrusted PR code gets no write credentials.
- Users install no new package and add no reporter to their Playwright config for balancing. Everything ships inside the GitHub Action; any reporter or planner it needs is bundled in the Action and injected by it.
- Engine floors: Flakiness balanced mode needs Playwright 1.62+, NSXBet needs 1.56+.

## Non-goals

- A new scheduler, live work queue, or generic orchestration platform.
- Hosted services (Currents, Cypress Cloud style parallelization) for the ordinary two-shard imbalance.
- Changed-specs-first prioritization from Gleb's quick-changed-specs recipe. It changes selection and would confound scheduling measurements.
- A universal dependency installer or app-start step. Callers keep their own.
- A guarantee of perfect 12.5 minute runs or any speedup claim beyond measured results.
- Generalizing one suite's result to all repositories.

## Success signal

A decision record exists with exact versions, passing semantic, failure-path, privacy, and artifact-completeness fixtures, and raw timings from one real-suite comparison. The record reads adopt, reject with reproduced reason, or inconclusive. If adopt, a minimal workflow PR ships with cold-start, refresh, diagnostics, and rollback documentation, and no custom engine code exists that an existing engine already covered.

## Assumptions

- The measurement target is `couture-cast` (public, Playwright 1.58.2, 2 shards, 1 worker per shard in CI at the time of writing). Adding shards and workers there is in scope; the before and after is the evidence.
- The deliverable is a new public GitHub Action repo under `muratkeremozcan`, shaped like `tea-test-review`.
- All packages and Actions float to latest. Every result records the resolved versions. Nothing maintains pins.
- History storage is the simplest option that works (engine format persisted as a GitHub Actions artifact or cache); the owner does not care which.
- The 10% median completion-time gate is provisional. Raw numbers are always reported so the owner can set the bar.
- The 12.5 minute example is an ideal bound, not a target the work promises.
- The reusable workflow targets GitHub Actions only.
