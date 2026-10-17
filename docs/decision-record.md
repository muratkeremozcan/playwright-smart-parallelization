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
- Real suite: [baseline.md](measurements/baseline.md). couture-cast completes in a median 602 s, 87% of it outside the critical test span; balancing can win at most the 23 s assignment gap (3.6%).
- S6 stopped: the owner wants the Action proven on a synthetic suite, independent of couture-cast. The couture-cast before and after moves to S9.

## Shape

One JavaScript action that drops into the user's own job: a main step before the user's Playwright command, which adds `$PSP_ARGS`, and a post step after it. The main step pins one history snapshot to the workflow run and decides the mode from its bytes. `$PSP_ARGS` adds a bundled preprocess reporter with `--add-reporter` and leaves the user's config and command alone. The post step uploads the shard's run record and publishes its samples. An optional `finish` action proves exactly-once coverage and writes the summary.

Shape A (per-shard `--test-list` files) is rejected: `--test-list` is a lossy selector that cannot pick out titles with `›`, title prefixes or helper-defined tests exactly ([limits](playwright-test-list-selection-limits.md)).

### Prepare dropped, finish optional (2026-10-17)

The three-phase interface (a prepare job, a run step that owned the Playwright command, a finish job) is replaced before v1. A prepare job and a plan output cost every user two extra jobs of wiring, and owning the command broke npm scripts, shell variables and checkouts of another commit. Each shard now pins the snapshot itself, as playwright-shard-balancer's restore action does but in a run artifact, and publishes its own samples by compare-and-swap, so the next run balances with no finish job. Finish stays as an optional check, because coverage across shards can only be proven after all of them, and a run without it still balances.

## Rules

- Lowest Playwright is 1.63: 1.62 has the preprocess hook but no `--add-reporter`. Older or unknown versions leave `$PSP_ARGS` empty.
- Yarn Plug'n'Play leaves `$PSP_ARGS` empty: the reporter has no `node_modules` to load Playwright from.
- The Playwright version is read from `working-directory` up, else from the projects under the workspace, so a project in a subdirectory needs no input.
- The shard comes from Playwright's resolved `config.shard`; a run without `--shard` is recorded as one native shard.
- The Action runs on node24 with the toolkit bundled; the reporter is bundled on its own and runs in the user's Node 20 or later.
- A unit is one spec file of one project at one repeat, also under `fullyParallel`, so a fully parallel file stays on one shard where native `--shard` can split it.
- Per-test units were investigated for fully parallel projects (2026-10-17) and rejected: the public API exposes `FullProject.fullyParallel`, but no field, annotation or `--list` output shows a `describe.configure({ mode: 'serial' | 'default' })` group or a `beforeAll` hook that keeps tests together.
  Playwright groups by the private `_parallelMode` and hooks, so only whole files keep every serial group whole without private fields.
- `--no-deps` is read from the user's command line, since the public `FullProject.dependencies` keeps its configured value; under it every project is ordinary and shares out in the split.
- `--last-failed` is refused before any test: Playwright filters after the split, where no reporter sees it, so a shard cannot prove the selection. The workaround is `enabled: false` for that command.
- Intentional skips are allowed and not flagged; a run where every test skipped fails finish.
- One unnamed project (a config without `projects`) has the identity `''`; two or more unnamed or duplicate names are refused before any test.
- The history key is working directory, the `workers` input, runner label and `history-key`. The command is the user's and runs after the Action, so a filter shares the history; each test keeps its own samples. Workers from the config or the CPUs, config path, environment and Playwright version share it too, so callers separate materially different setups with `history-key`, `runner-label` or an explicit `workers`.
- The Action runs on node24, so a self-hosted runner needs Actions runner v2.327.1 or later.
- The pin is an artifact of the workflow run named by job id and history key, never by the commit, so a workflow that checks out another commit plans the same on every shard and re-run. An artifact name is unique in a run, so the first upload wins, and an artifact outlives the cache's eviction, so a re-run days later still finds it.
- A pin that is never found fails the shard before any test, since a shard on other bytes could run a test twice or not at all. Every shard reads the pin before the cache, so a shard without the cache, or with a cache mode that refuses reads, still plans from a pin another shard wrote; a pin written without the cache holds no history, so the job runs native; a job whose cache mode refuses reads or writes publishes nothing, since a publish merges what the cache holds.
- A re-run that finds no pin, because the run's artifacts expired, runs unpinned when the job's earlier shards did, and otherwise fails before any test: it cannot plan as shards that read the lost pin. With no record either, it pins afresh only when the repository keeps artifacts for the 30 days a run can be re-run, or the run is younger than the retention (its age from the runs API), since only then does a missing pin prove that no shard read one.
- Finish is the only cross-shard proof. A run without it still balances; each shard job's own status stays the caller's.
- Each shard's main step uploads a start marker whose token its record carries. Finish fails when a shard job started in an attempt and left no record, unless every shard it could have been was re-run later, so an earlier record never stands for a re-run that failed before the reporter, was cancelled or lost its upload. A shard that was not re-run keeps its earlier record. A shard whose marker upload fails after retries stops before any test, since finish could not see it; its red job is then the only signal.
- Rollback (`enabled: false`) leaves `$PSP_ARGS` empty and uploads a status record, so finish tells a rollback from shards that never ran.
- The plan packs for the `workers` input, or for 1 worker when it is unset, so every shard plans the same on any runner.

## History publish

- `publish-history: auto` publishes from the default branch only. A cache entry saved on another ref is visible to that ref alone, so a branch would read its own stale entries.
- `true` also publishes from same-repository branches and pull requests, into their own cache scope. `false` never publishes.
- Fork pull requests and `pull_request_target` never publish; they read the base history like any run.
- Every shard publishes the samples of its passing tests under the run's id, also when another test failed; a failed attempt adds no sample. A test has one sample per run whichever shard ran it; a setup test several shards ran keeps the smallest. This replaces the one trusted writer of the original contract, so the next run balances with no finish job.
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

## Release promotion

- The promote job has a concurrency group per major, and it reads the highest published release of the major again right before it moves the tag, so a delayed older release never moves the major back.
- Verify fails a release that a newer one superseded while it was verified, so its promotion never queues where it would displace the newer pending one. Tests run the promote steps against a mocked API.

## Remaining gaps

- A real fork pull request has not run; the fork rule is tested with event payloads.
- A genuine GitHub re-run attempt has not run; re-runs are tested with attempts in the local artifact model.
- No stable release is cut yet; the release workflow has not published a tag.
- The couture-cast before and after (S9).
