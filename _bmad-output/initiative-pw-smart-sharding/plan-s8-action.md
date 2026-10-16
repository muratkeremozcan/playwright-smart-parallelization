---
title: 'S8 The Action: duration-balanced Playwright sharding'
type: 'feature'
ticket: 'S8'
created: '2026-10-16'
status: 'in-progress'
baseline_revision: 'a137eec7f37d4f07bbb4930aa64c4e8f1c0b5c97'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/research/shard-balancer-harvest.md'
  - '{project-root}/_bmad-output/initiative-pw-smart-sharding/spec-pw-smart-sharding/spec-pw-smart-sharding.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Native `--shard` splits Playwright tests by count, so shards finish unevenly and the run waits for the slowest; `action.yml` is a stub that fails on purpose.

**Approach:** Our own engine (CAP-7, S7 verdict) shipped as one composite Action with a `phase` input (`prepare`, `run`, `finish`): prepare pins one validated history snapshot and decides balanced or native for the whole run, each shard runs the user's command with a bundled preprocess reporter added through `--add-reporter`, and finish proves exactly-once coverage, summarizes imbalance and publishes history by compare-and-swap into the repo's own Actions cache through the official `actions/cache/restore` and `actions/cache/save` steps.

## Boundaries & Constraints

**Always:** public `Reporter.preprocess` / `testRun.exclude` / `testRun.skipSharding` only; whole files per project and repeat as the unit; user config untouched, no user package; whole-run fallback to native decided in prepare (Playwright below 1.62 or unknown, no, empty or damaged history, `enabled: false`); strict once balanced; one snapshot per run verified by sha in every shard before Playwright starts; history keyed by command, working directory, workers, runner label and `history-key`; median of the last 5 passing samples ordered by run id, passing attempt only, no 0 ms sample; new-test estimate describe, file, project, suite; deterministic bytes; validation and atomic save; publish only from complete, passing, checked runs by a trusted writer (no fork PR, no `pull_request_target`); MIT attribution for ported playwright-shard-balancer code; zero runtime npm dependencies.

**Never:** `_parallelMode`, `_locks` or any private field; shape A (`--test-list`); a wrapper config; a fixed sleep; a third-party service; network calls from the reporter; mixed native and balanced shards in one run; touching couture-cast; releases or tags.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cold start | no history | every shard runs native `--shard`, finish publishes first history | none |
| Warm | valid history, Playwright 1.62+ | every shard logs one plan line with the same plan sha, leaves run once | none |
| Damaged snapshot in one shard | sha differs from prepare | that shard fails before any test, run red | fail closed |
| Failed shard | a test fails | records uploaded, finish fails, history bytes unchanged | fail |
| Missing or duplicate record | shard crashed, re-run | finish fails before history write, latest attempt kept per shard | fail |
| Rollback | `enabled: false` | plain `--shard`, no reporter, no plan line, no history write | none |
| Racing writers | two finish jobs on one sequence key | the exact-key read-back differs from what was written, so the loser re-reads and saves the next key, both runs' samples kept | bounded attempts, then fail loud |
| Fork PR | untrusted head repo | balances from base history, writes nothing | skip publish |

</frozen-after-approval>

## Code Map

- `action.yml`, `main.js` -- stub to replace; `tests/main.test.js` asserts stub behavior and must change.
- `.github/workflows/test.yml` -- `stub` job to replace with the e2e jobs.
- `harness/` -- `nativePartition` shape `{ args, env }`; partitions with `--add-reporter` plug in unchanged for exactly-once proofs.
- `fixtures/consumer` -- Playwright 1.64.1, setup/teardown projects, two browser projects, serial suites, retries.
- `research/shard-balancer/node_modules/playwright-shard-balancer/dist/{partition,plan,estimate,timings,run,report}.js` -- algorithms to port with attribution (partition search, setup-aware balance, estimator, check).
- `docs/research/shard-balancer-harvest.md` "Inputs to S7 and S8" -- every acceptance row is covered by a test or answered in the decision record.
- `actions/cache/restore`, `actions/cache/save` -- official steps; a key is immutable, so a save onto an existing key is the conflict signal, detected by restoring the exact key and comparing its sha.

## Tasks & Acceptance

**Execution:**
- [x] `lib/plan/*.js` -- port partition and setup-aware balance; units, estimator.
- [x] `lib/history.js` -- schema, validation, merge window by run id, deterministic serialize.
- [x] `lib/check.js`, `lib/summary.js` -- exactly-once check, imbalance and simulate summary.
- [x] `lib/store.js` -- sequence keys, union merge of every entry read, next-key choice and read-back verification between the official cache steps.
- [x] `reporter/reporter.js` -- preprocess reporter, options from the environment, run record.
- [x] `lib/prepare.js`, `lib/run.js`, `lib/finish.js`, `lib/playwright-version.js`, `lib/command.js` -- phase logic.
- [x] `action.yml` -- composite with `phase`; official cache restore and save steps unrolled for bounded compare-and-swap attempts; artifacts for snapshot, records, blob reports.
- [x] `tests/*.test.js` -- unit and harness-backed tests for every matrix row and harvest acceptance row.
- [x] `.github/workflows/test.yml` -- e2e on `fixtures/consumer`: cold, warm, failed shard, rollback, race.
- [x] `docs/decision-record.md`, `README.md`, `stories.md` -- docs, S7 and S8 ticked, S6 struck as stopped by the owner.

**Acceptance Criteria:**
- Given the e2e workflow, when it runs on a PR, then cold start publishes history, the next run balances from it with one plan sha, a failed shard fails finish, rollback runs native, and the harness proves exactly-once coverage.
- Given `npm run validate`, when run, then lint, format, unit tests and the public check pass.

## Implementation Notes

- Checkpoint 1 approved by the coordinator (owner delegate) on 2026-10-16 with one change: official cache actions in place of a hand-rolled cache client.
- Experiments on the fixture (Playwright 1.64.1): a throw in `preprocess` exits 1 with zero tests run; `exclude` plus `skipSharding` keeps setup and teardown; a later `--add-reporter` replaces an earlier one, so the action merges the user's value into its own.

## Plan Change Log

- 2026-10-16, floor 1.63: Playwright 1.62.0 has `Reporter.preprocess` but no `--add-reporter` (its `--help` and `lib/program.js` lack it; 1.63.0 has it), so prepare falls back for anything below 1.63. The frozen intent's "below 1.62" is kept in spirit: the fallback covers every version the injection cannot reach.
- 2026-10-16, coordinator: README.md is not touched in this story; the coordinator adds Usage after rebasing. Harness rules that lived only in the README moved into harness/ comments.
- 2026-10-16, coordinator: finish merges the downloaded blob reports (latest attempt per shard) into one HTML report artifact with `npx playwright@<plan version> merge-reports`; a failed merge is a warning.
- 2026-10-16, coordinator (review G2, G4): G2 cases 1-7 are answered in docs/decision-record.md with their tests; a browser-free lifecycle fixture (`fixtures/consumer/lifecycle.config.js`) compares native and balanced lifecycles; intentional skips are allowed and an all-skipped run fails; unnamed projects are refused before any test.
- action.yml is rendered by `scripts/render-action.js` (its env blocks and the unrolled compare-and-swap repeat by design); a test pins the file to the output.
- `disabled` passes `--workers` when the workers input is set, so rollback keeps the worker count of the balanced run.

## Review Triage Log

## Design Notes

Consumer interface (keep it this short; the user's checkout, install and app-start steps stay theirs):

```yaml
prepare:  # outputs: matrix, plan
  steps: [checkout, { id: psp, uses: muratkeremozcan/playwright-smart-parallelization@SHA, with: { phase: prepare, shards: 4, command: npx playwright test } }]
test:     # needs prepare; strategy.matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}
  steps: [checkout, setup-node, install, { uses: ...@SHA, with: { phase: run, plan: ${{ needs.prepare.outputs.plan }}, shard: ${{ matrix.shard }} } }]
finish:   # needs [prepare, test]; if: ${{ !cancelled() }}
  steps: [{ uses: ...@SHA, with: { phase: finish, plan: ${{ needs.prepare.outputs.plan }} } }]
```

- **prepare** reads the Playwright version from the lockfile (npm, pnpm, yarn, bun) or `node_modules`, searching up from `working-directory`; rejects `--shard` in `command`; history key = sha of command, working directory, workers, runner label (default `runner.os-runner.arch`) and `history-key`. Restores the newest entry by prefix, validates it, writes the snapshot, and outputs `matrix` `{"shard":[1..n]}` and `plan` JSON `{v, mode: balanced|native|disabled, reason, total, sha, key, command, workingDirectory, workers, fingerprint, runId}`. Uploads the snapshot artifact only when balanced.
- **run** validates `shard`, checks the installed Playwright version when balanced (fail before tests below 1.62), downloads the snapshot and verifies its sha, then runs `command --shard=i/n [--workers=w] --add-reporter=<merged>` in `working-directory`; `disabled` runs `command --shard=i/n` only. A user `--add-reporter` in `command` is folded into the action's single value. Uploads the run record (`if: always()`, name carries shard and run attempt) and the blob report folder when present.
- **reporter** (CommonJS, bundled): options from `PSP_*` environment. `preprocess` builds units per (project, spec file, repeat) for non-dependency projects, prices them from the snapshot, plans, excludes other shards' tests, calls `skipSharding`, and logs one line with snapshot sha, plan sha, known/total tests. Balanced is strict: any snapshot problem throws. `onEnd` writes the record: run identity, fingerprint, mode, plan and snapshot shas, predicted ms per shard, corpus (`[test id, label]` of the full unsharded selection, setup excluded), and per test `{id, key, repeat, setup, outcome, ran, sample_ms}` where `sample_ms` is the duration of the passing attempt.
- **finish** keeps the latest attempt per shard, checks: one record per shard, one mode equal to the plan, one plan sha, one snapshot sha, one corpus, one fingerprint, no non-setup id twice, union equals corpus, none not-run, every shard passed. It writes the job summary (per-shard predicted and measured, slowest, spread, imbalance, simulated next two shard counts with the measured per-shard overhead when the jobs API is readable). It publishes only when the check passed, every shard passed, mode is not `disabled`, the writer is trusted and `publish-history` is true; then fails the job if the check or any shard failed.
- **history** `{schema, version: 1, key, runs: [run ids applied, last 200 sorted], tests: {key: {samples: [[runId, ms]] max 5 by highest run id, seen: YYYY-MM-DD}}}`; setup tests get one sample per run (median across shards); entries unseen for 30 days drop; serialize with sorted keys; merge is a union over entries, so merging every entry read is safe and idempotent.
- **compare-and-swap** inside the composite, unrolled to a fixed number of attempts: restore newest by prefix `psp-history-v1-<key>-` into a relative path, merge with every entry already read, choose `seq = max(seen, attempted) + 1`, save `…-<seq>`, clear the folder, restore that exact key, compare sha. A different sha means another writer owns the key: its entry joins the merge and the next attempt uses the next key. A miss means the other writer has not finished: the next attempt also moves past that key. After the last attempt, fail loud with history unchanged.
- **Attribution**: ported functions keep the MIT notice of playwright-shard-balancer (Copyright (c) 2026 Gary Parker) in the file header, and the README names it.

## Verification

**Commands:**
- `npm run validate` -- expected: exit 0
- `gh pr checks` -- expected: every check green, e2e jobs included
