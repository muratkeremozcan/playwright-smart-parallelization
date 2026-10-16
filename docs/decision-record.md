# Decision record

## Verdict

We build our own engine (CAP-7). NSXBet does not qualify: it fails the exactly-once and serial proofs (P1, P2). Flakiness qualifies with five named gaps and reads the private `_parallelMode`, which the spec forbids. playwright-shard-balancer was harvested for ideas only; its MIT-licensed planner code is ported with attribution in `lib/plan/`.

## Versions

| Component                       | Version                    |
| ------------------------------- | -------------------------- |
| Playwright (fixture)            | 1.64.1                     |
| Lowest Playwright               | 1.63.0                     |
| @flakiness/playwright           | 2.0.2, qualifies with gaps |
| @nsxbet/playwright-orchestrator | 2.0.1, does not qualify    |
| playwright-shard-balancer       | 0.1.2, harvested           |
| Node                            | 22 and 24                  |

## Evidence

- Fixture: [nsxbet.md](qualification/nsxbet.md), [flakiness.md](qualification/flakiness.md), [comparison.md](qualification/comparison.md). On three shards a duration split cut the slowest shard from 12.4 s to 9.9 s.
- Harvest: [shard-balancer-harvest.md](research/shard-balancer-harvest.md). Its acceptance rows are covered by the tests in `tests/`; the rows that need a real suite are under Remaining gaps.
- Real suite: [baseline.md](measurements/baseline.md). couture-cast completes in a median 602 s, 87% of it fixed setup; balancing can win at most the 23 s assignment gap (3.6%).
- S6 (candidate runs) was stopped by the owner. The before and after on couture-cast moves to S9.

## Shape

One composite Action with a `phase` input. `prepare` decides the mode of the whole run and pins one history snapshot. `run` adds a bundled preprocess reporter with `--add-reporter` and leaves the user's config alone. `finish` proves exactly-once coverage, merges the blob reports, writes the summary and publishes the history by compare-and-swap on the repository's Actions cache.

## Rules

- Lowest Playwright is 1.63: 1.62 has the preprocess hook but no `--add-reporter`. Older or unknown versions run plain `--shard`.
- A unit is one spec file of one project at one repeat. Whole files keep serial groups whole without private fields.
- Intentional skips are allowed and not flagged; a run where every test skipped fails finish.
- Unnamed or duplicate project names are refused before any test runs.
- A filter belongs in `command`, which keys the history, so a filtered run has its own history.
- Per-shard `--test-list` files (shape A) are not used: the reporter excludes tests through `testRun.exclude`.
- The plan packs for the `workers` input. Whether that beats packing for one worker was an S6 measurement and is still open.
- A `command` with `--last-failed`, `--only-changed`, `--list`, `--shard` or `--workers` is refused.

## Review cases (G2)

1. Plan binding: the plan names run, commit, key, Playwright fingerprint, shard count, mode and snapshot sha; run and finish refuse any other (`tests/phases.test.js`). The corpus is checked in finish, since prepare runs before install (`tests/check.test.js`).
2. One decision before fan-out, strict shards, rollback: `tests/phases.test.js`, `tests/reporter-safety.test.js`, `tests/action-flow.test.js`.
3. Expected shards and attempts: `tests/check.test.js`, `tests/action-flow.test.js`.
4. Failed, cancelled and incomplete runs write nothing; keys separate runner, workers and command: `tests/history.test.js`, `tests/action-flow.test.js`, `tests/phases.test.js`.
5. Order, replay and permutation give one byte form: `tests/history.test.js`. The plan and the history read no clock; dates only expire entries.
6. Window behavior and the passing-attempt sample: `tests/history.test.js`, `tests/lifecycle.test.js`. Its bias shows in the predicted and measured columns of every summary.
7. Untrusted runs read and never write; forged plans are refused; finish runs only the Action's code: `tests/phases.test.js`, `tests/action-flow.test.js`.

## Remaining gaps

- A save that finishes after a later key was saved can drop that writer's samples for one run. The cache has no listing the Action can rely on.
- The fork rule is tested with a fork event payload; a real fork pull request is still to run.
- The couture-cast before and after (S9).
