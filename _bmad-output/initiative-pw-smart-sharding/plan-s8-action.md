---
title: 'S8 The Action: duration-balanced Playwright sharding'
type: 'feature'
ticket: 'S8'
created: '2026-10-16'
status: 'in-review'
baseline_revision: 'a137eec7f37d4f07bbb4930aa64c4e8f1c0b5c97'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 1
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

- 2026-10-16, review loop 1 (Codex, adversarial, quick, code review, test review). Amended Design Notes for: compare-and-swap (never skip an unreadable key, heal a damaged newest entry, start a cold chain only when prepare saw no history), the publish rule (`publish-history: auto` publishes from the default branch only), a disabled-mode status record so finish stays a gate under rollback, a single unnamed project, the prepare run attempt in the plan, `--no-deps` refused. Known-bad states avoided: a damaged or out-of-order entry wedging every later finish; a pending save silently dropping a run; a stale attempt record passing finish; a same-repo branch reading its own stale scope. KEEP: one composite with `phase`; the rendered action.yml and its pin test; the reporter's public-API planning; union merge and window by run id; the composite model tests; the token isolation fix. Code is patched in place, since the defects are local to these modules.

## Review Triage Log

### Loop 1 (2026-10-16)

Counts: high 9, medium 17, low 8, false 1, maybe-false 0. Routed: bad_plan 6 (fixed in place with the amended Design Notes), patch 28, false 1.

| Source | Finding | Verdict | Route | Evidence or action |
|---|---|---|---|---|
| Codex | reporter.js:204 `--no-deps` duplicates setup across balanced shards | high | bad_plan | Codex repro; prepare refuses `--no-deps` |
| Codex, adversarial | check.js stale earlier-attempt record covers a shard that never ran after re-run all | high | bad_plan | adversarial A3 repro; plan carries prepare attempt, older records refused |
| Codex, adversarial, quick | store.js pending key skipped, a run's samples lost | high | bad_plan | pending.test.js repro; never move past an unreadable key, fail loud after the attempts |
| adversarial, code review, quick | store.js damaged newest entry wedges every later finish | high | bad_plan | A1 repro; heal by publishing over it, the job fails once loudly |
| adversarial | store.js seq above newest-created jams finish | medium | bad_plan | A2 repro; cold chain only when prepare saw no history, next seq above the plan's seq |
| code review, quick | same-repo PR scope reads its own stale entries | medium | bad_plan | cache ref scoping; `publish-history: auto` writes from the default branch only |
| code review | composite model leaks host GITHUB_EVENT_PATH, validate red in CI | high | patch | run 38973814052 log |
| code review | e2e failed-shard finish skipped, CI red | high | patch | finish `if` requires test success |
| Codex, code review, quick | fork PR fails e2e, seed jobs write caches | high | patch | trust() refuses forks; gate e2e to trusted events |
| code review, adversarial | disabled finish green on failed shards | medium | patch | status record per shard in disabled mode |
| code review, quick | single unnamed project fails every shard | medium | patch | Playwright's implicit project is `''`; allow one, refuse two or more |
| code review | Yarn PnP: run finds no install | medium | patch | prepare picks disabled when `.pnp.cjs` exists |
| adversarial | workspace lockfile version differs from the nested install | medium | patch | mono repro; resolve from the working directory upward, pnpm importers |
| code review, quick | CAS steps inherit success(), model omits it | medium | patch | composite.js:224; `!cancelled() &&` and model adds implicit success() |
| test review, code review | e2e legs share run id, key and artifact names | medium | patch | distinct history key per leg; a balanced leg that publishes |
| test review, code review | history key uses run_attempt, re-run fails | medium | patch | key on run_id only |
| quick | e2e never publishes from a balanced run | medium | patch | same fix as the e2e keys |
| code review | summary numbers unasserted | medium | patch | add a markdown() test |
| test review | lifecycle sample test cannot tell attempts apart | medium | patch | uneven sleeps per retry |
| test review | 1.62 and no-version cases miss the mode | medium | patch | assert disabled |
| test review | setup-free shard branch never runs | medium | patch | project with no dependencies |
| test review | latest-attempt order untested | medium | patch | reversed order case |
| test review | fork prepare never tested for balanced | medium | patch | add the case |
| test review | e2e failed leg cannot see a wrong publish | medium | patch | own seeded key |
| code review | self-hosted runner names match the wrong job | low | patch | also require the job window to contain the record |
| code review | decision record says finish runs only the Action's code | low | patch | record the registry fetch for merge-reports |
| code review | `..e2e` folder refused | low | patch | compare against `..` + separator |
| quick | download-artifact pattern layout comment and model wrong | low | patch | pattern downloads go to subfolders |
| quick | refused flag list incomplete in the decision record | low | patch | list them all |
| quick | antithesis phrasing in three strings | low | patch | rewrite |
| quick | README still the skeleton | low | patch | the coordinator owns README; Usage lands after psp-fix rebase |
| adversarial | publish failure fails a passing finish | low | patch | kept loud per the frozen row; contention now needs four writers at once |
| Codex | e2e seed jobs on forks | high | patch | merged into the fork gate row |
| code review | rejected items in its own report | false | reject | its reasons hold |
| adversarial | four simultaneous finishers fail the fourth | low | patch | documented bound in the decision record |

### Loop 2, Codex round 2 (2026-10-16)

| Source | Finding | Verdict | Route | Evidence or action |
|---|---|---|---|---|
| Codex | store.js:90 restore failures in prepare and finish recreate key 1 below surviving keys, jamming finish | medium | patch | epoch per chain: a writer that starts a chain uses its run id as the epoch, so a new chain never collides with old keys |
| Codex | check.js:81 a partial re-run that dies before Playwright keeps the shard's earlier passing record | false | reject | that record is a complete, passing run of the same shard under the same plan, so coverage is exactly once and the history it feeds is valid; the shard job that died still turns the workflow red |

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
- **compare-and-swap** inside the composite, unrolled to a fixed number of attempts (`!cancelled() &&` on every step): restore newest by prefix into a relative path, merge with every entry already read, choose `seq = max(seen, attempted, plan.seq) + 1` where `plan.seq` is the entry prepare pinned, save, clear, restore that exact key, compare sha. A different sha: that entry joins the merge and the next attempt moves on. A miss: another writer holds the key and has not finished, so the next attempt retries that same key and never skips it; after the last attempt, fail loud with history unchanged. A finish whose prefix read misses while prepare had pinned an entry publishes nothing (cache unavailable), so a cold chain starts only when prepare saw no history. A damaged newest entry is reported as an error, its seq counts as seen, and this run's merge is published over it, so the next run is healthy.
- **publish rule**: `publish-history` is `auto` (default branch only: push, schedule or dispatch on the repository's default branch), `true` (also same-repository branches and pull requests, which write into their own cache scope) or `false`. Fork pull requests and `pull_request_target` never publish.
- **plan** carries prepare's `GITHUB_RUN_ATTEMPT`; finish refuses records from an earlier attempt.
- **disabled** mode: run writes and uploads a status record per shard (shard, attempt, exit code) without the reporter, so finish fails when a shard failed or never ran.
- **projects**: one unnamed project (Playwright's implicit `''`) is supported; two or more unnamed or duplicate names are refused in preprocess. `--no-deps` is refused in prepare. A Yarn Plug'n'Play project (`.pnp.cjs`) runs disabled. The Playwright version comes from the lockfile entry Node would resolve from `working-directory` (nested npm entries, pnpm importers).
- **Attribution**: ported functions keep the MIT notice of playwright-shard-balancer (Copyright (c) 2026 Gary Parker) in the file header, and the README names it.

## Verification

**Commands:**
- `npm run validate` -- expected: exit 0
- `gh pr checks` -- expected: every check green, e2e jobs included
