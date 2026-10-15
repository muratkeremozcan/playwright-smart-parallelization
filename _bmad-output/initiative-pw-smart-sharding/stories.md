# Stories and run protocol

Source of truth for the build: `spec-pw-smart-sharding/`. One story at a time. Each story is one branch, one PR against `main`, one fresh worker.

Decisions (owner, 2026-10-15): float every package and Action to latest and record resolved versions in results; measurement target is `~/opensource/couture-cast` (public); deliverable is this public repo, shaped like `~/opensource/tea-test-review`; history storage is the simplest thing that works; the 10% gate is provisional and raw numbers are always reported; nothing employer-related appears in this repo.

## Stories

- [x] **S1 Repo skeleton (CAP-4 base).** Node action in the shape of `tea-test-review` (`action.yml`, `main.js`, `scripts/`, `tests/`, MIT `LICENSE`, README stub, lint, format, unit test runner, CI workflow running them). `action.yml` can be a stub that fails with a clear "not implemented" until S8. ([#1](https://github.com/muratkeremozcan/playwright-smart-parallelization/pull/1))
- [x] **S2 Consumer fixture and coverage harness (CAP-1).** `fixtures/consumer`: latest `@playwright/test`, covering every shape in `engine-qualification.md` "Consumer fixture". Harness that lists the intended leaf set (`--list --reporter=json`), runs a candidate partition, and asserts exactly-once coverage and serial-group integrity. Baseline: native `--shard`. ([#2](https://github.com/muratkeremozcan/playwright-smart-parallelization/pull/2))
- [ ] **S3 NSXBet qualification (CAP-1, CAP-5, CAP-6).** Run all 8 proofs plus damaged-timing and racing-publish cases against the latest `@nsxbet/playwright-orchestrator`. Automated where possible. Write `docs/qualification/nsxbet.md` with resolved versions, pass or reproduced fail per proof, runtime and footprint.
- [ ] **S4 Flakiness qualification (CAP-1, CAP-5, CAP-6).** Same for the latest `@flakiness/playwright` with `disableUpload: true`. Add a network audit that proves no outbound vendor connection. Write `docs/qualification/flakiness.md`.
- [ ] **S5 couture-cast baseline (CAP-2).** In `~/opensource/couture-cast` on a branch: upgrade `@playwright/test` to latest if needed, then measure the current CI shape (2 shards, 1 worker) with at least 5 runs via `workflow_dispatch` or repeated PR runs. Record per-shard and end-to-end durations, queue delay separately. Results go to `docs/measurements/baseline.md` in this repo (raw JSON alongside).
- [ ] **S6 Candidate runs (CAP-2).** On couture-cast branches: more parallelization with native sharding (more shards, more workers where the app and services tolerate it) and with each qualified engine. Matched, alternating order, at least 5 pairs. Results to `docs/measurements/candidates.md` with raw data.
- [ ] **S7 Decision record (CAP-3).** `docs/decision-record.md`: versions, fixture results, measurements, verdict (adopt, reject with reason, inconclusive), smallest remaining gap. Coordinator reviews and confirms before S8 starts.
- [ ] **S8 The Action (CAP-4, CAP-5, CAP-6, or CAP-7 if the verdict demands it).** Implement `action.yml`: prepare, matrix-ready shard assignment, aggregate, history update, imbalance summary, single rollback switch. Unit tests plus an end-to-end run on the fixture in this repo's CI.
- [ ] **S9 couture-cast integration and final before and after (CAP-2, CAP-4).** PR in couture-cast adopting the Action; final measurement; README with usage, cold start, refresh, diagnostics, rollback, and the real numbers.

## Protocol

- Coordinator: Kerem session `5c387950-377b-4063-acb0-a211d8f33a3f`. Owner is away; the coordinator merges and decides.
- Workers are Claude peer sessions, one per story, closed when the story merges.
- A story merges only after the worker reports `completed` with green CI.
- Every finding is fixed in the story that found it. The story count may only fall.
- Coordinator rules appended by date below.
