# Decision record

## Verdict

We build our own engine (CAP-7).

- NSXBet does not qualify: it fails P1, P2, P6, P8, X1 and X2.
- Flakiness qualifies with five named gaps and reads the private `_parallelMode`, which the spec forbids.
- playwright-shard-balancer was harvested for ideas only. Its MIT-licensed planner is ported with attribution in `lib/plan/`.

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
- Harvest: [shard-balancer-harvest.md](research/shard-balancer-harvest.md). Its acceptance rows are listed below.
- Real suite: [baseline.md](measurements/baseline.md). couture-cast completes in a median 602 s, 87% of it fixed setup; balancing can win at most the 23 s assignment gap (3.6%).
- S6 stopped: the owner wants the Action proven on a synthetic suite, independent of couture-cast. The couture-cast before and after moves to S9.

## Shape

One JavaScript action that drops into the user's own job: a main step before the user's Playwright command, which adds `$PSP_ARGS`, and a post step after it. The main step pins one history snapshot to the workflow run and decides the mode from its bytes. `$PSP_ARGS` adds a bundled preprocess reporter with `--add-reporter` and leaves the user's config and command alone. The post step uploads the shard's run record and publishes its samples. An optional `finish` action proves exactly-once coverage and writes the summary.

Shape A (per-shard `--test-list` files) is rejected: `--test-list` is a lossy selector that cannot pick out titles with `›`, title prefixes or helper-defined tests exactly ([limits](playwright-test-list-selection-limits.md)).

### Prepare dropped, finish optional (2026-10-17)

The three-phase interface (a prepare job, a run step that owned the Playwright command, a finish job) is replaced before v1. A prepare job and a plan output cost every user two extra jobs of wiring, and owning the command broke npm scripts, shell variables and checkouts of another commit. Each shard now pins the snapshot itself, as playwright-shard-balancer's restore action does, and publishes its own samples by compare-and-swap, so the next run balances with no finish job. Finish stays as an optional check, because coverage across shards can only be proven after all of them, and a run without it still balances.

## Rules

- Lowest Playwright is 1.63: 1.62 has the preprocess hook but no `--add-reporter`. Older or unknown versions leave `$PSP_ARGS` empty.
- Yarn Plug'n'Play leaves `$PSP_ARGS` empty: the reporter has no `node_modules` to load Playwright from.
- The Playwright version is read from `working-directory` up, else from the projects under the workspace, so a project in a subdirectory needs no input.
- The shard comes from Playwright's resolved `config.shard`; a run without `--shard` is recorded as one native shard.
- The Action runs on node24 with the toolkit bundled; the reporter is bundled on its own and runs in the user's Node 20 or later.
- A unit is one spec file of one project at one repeat. Whole files keep serial groups whole without private fields.
- Intentional skips are allowed and not flagged; a run where every test skipped fails finish.
- One unnamed project (a config without `projects`) has the identity `''`; two or more unnamed or duplicate names are refused before any test.
- The history key is working directory, workers, runner label and `history-key`. The command is the user's and runs after the Action, so a filter shares the history; each test keeps its own samples.
- The pin is keyed by history key, run id and job id, never by the commit, so a workflow that checks out another commit plans the same on every shard and re-run.
- A pin that never reads back fails the shard before any test, since a shard on other bytes could run a test twice or not at all. A cache that refuses writes refuses them for every shard, so every shard runs native.
- Rollback (`enabled: false`) leaves `$PSP_ARGS` empty and uploads a status record, so finish tells a rollback from shards that never ran.
- The plan packs for the `workers` input, or for 1 worker when it is unset, so every shard plans the same on any runner.

## History publish

- `publish-history: auto` publishes from the default branch only. A cache entry saved on another ref is visible to that ref alone, so a branch would read its own stale entries.
- `true` also publishes from same-repository branches and pull requests, into their own cache scope. `false` never publishes.
- Fork pull requests and `pull_request_target` never publish; they read the base history like any run.
- Every shard publishes the samples of its passing tests under the run's id, so a test has one sample per run whichever shard ran it; a setup test several shards ran keeps the smallest.
- A cache key is immutable, so a save onto an existing key changes nothing. A shard reads its key back: other bytes mean another writer won, and that entry joins the merge.
- An unreadable key is retried on the next attempt. Each lost attempt lets one other writer through, so a shard makes `max(8, shards + 4)` attempts; after the last it warns and the history is unchanged.
- A damaged newest entry is reported, and the shard's merge is published over it, so the next run reads a healthy history.
- Keys are `psp-history-v2-<key>-<epoch>-<seq>`. A writer that saw no history starts a chain under the UTC date of its write (YYYYMMDD); every other writer continues the epoch of the entry it read. Cold writers of one day meet on the first key and merge; a chain started on a later day never collides with old keys. Two cold writers on either side of midnight can drop one shard's samples.

## Review cases (G2)

1. One snapshot per run and job, never per commit: `tests/units.test.js` (pin), `tests/action-flow.test.js` (head commit). The corpus is checked in finish: `tests/check.test.js`.
2. One decision from the pinned bytes, strict shards, rollback: `tests/units.test.js`, `tests/reporter-safety.test.js`, `tests/action-flow.test.js`.
3. Expected shards and attempts: `tests/check.test.js`, `tests/action-flow.test.js`.
4. A failed test writes only the samples of the tests that passed; keys separate runner, workers and history key: `tests/history.test.js`, `tests/action-flow.test.js`, `tests/units.test.js`.
5. Order, replay and permutation give one byte form: `tests/history.test.js`. The plan and the history read no clock; dates only expire entries.
6. Window behavior and the passing-attempt sample: `tests/history.test.js`, `tests/lifecycle.test.js`. Its bias shows in the predicted and measured columns of every summary.
7. Untrusted runs read and never write; a pin of another job or run is refused: `tests/units.test.js`, `tests/action-flow.test.js`.

## Harvest acceptance rows

- P5 mismatched input: `reporter-safety` (other snapshot), `units` (the pin).
- P5 dropped reporter: `reporter-balance` (`--reporter=list`), `check` (no records).
- P6 and NSX P6 missing record: `action-flow` (missing `$PSP_ARGS`, a job with a shard that never ran).
- P7 cold start: `action-flow` (cold), e2e cold.
- P8 faster, slow failure, slow retry: `history` (window), `lifecycle` (passing attempt).
- X2 racing publish: `action-flow` (eight shards at once), `units` (compare-and-swap, the publish loop), e2e eight shards.
- NSX P1 repeats and title collision: `reporter-balance` (repeat-each, repeat collision).
- NSX P2 serial groups, no private field: `reporter-balance` (fully parallel), `action-yml` (field scan).
- NSX P8 damaged, failed, cancelled: `action-flow` (damaged entry, failed test), `check` (not run).
- X1 damaged snapshot: `reporter-safety`.
- X2 delayed older run: `history` (delayed older run).
- Workers input: `reporter-balance` (plan sha under workers), `units` (history key).
- Pinned snapshot and re-run: `units` (the pin), `action-flow` (re-run shard), e2e re-run.
- Max failures and latest attempt: `reporter-safety` (max failures), `check` (latest attempt).
- Summary and aggregate failures: `units` (markdown), `check`.
- Rollback: `reporter-balance` (native leaves equal plain), `action-flow` (rollback).
- Trusted writer, provenance, fingerprint: `action-flow` (cold), `check` (fingerprint), `units` (publish rule).
- Filtered run: its tests keep their own samples in the shared history (`action-flow`, shell variables); expiry: `history`.
- Zero samples: `history`.
- Runner and workers keys: `units` (history key).
- No network: `reporter-safety` (guard).
- Plan line and summary row: `reporter-balance`, `units`.
- Strict shards: `reporter-safety`.
- New-test estimate: `plan` (estimator), `history` (renamed test).
- Simulate: `units` (simulate).
- Setup once and setup-free shards: `history` (setup median), `reporter-balance` (setup-free project).
- Deterministic search: `plan` (never above built-in), `reporter-safety` (slow clock).
- Dedupe: `action-flow` (re-run shard), `units` (a history that holds these samples).
- Validation and save: `action-flow` (damaged entry).
- Deterministic bytes: `history` (either order).
- Exclusion through the public API: `reporter-balance`.
- Shape A `--test-list` files: not used (see Shape).
- `--add-reporter` with options in the environment: `reporter-balance` (TypeScript config), `action-flow` (npm script).
- Fork pull requests: `action-flow` (a fork balances from the base history and publishes nothing).

## Remaining gaps

- A real fork pull request has not run; the fork rule is tested with event payloads.
- The couture-cast before and after (S9).
