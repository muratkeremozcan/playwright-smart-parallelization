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

One composite Action with a `phase` input. `prepare` decides the mode of the whole run and pins one history snapshot. `run` adds a bundled preprocess reporter with `--add-reporter` and leaves the user's config alone. `finish` proves exactly-once coverage, merges the blob reports, writes the summary and publishes the history.

Shape A (per-shard `--test-list` files) is rejected: `--test-list` is a lossy selector that cannot pick out titles with `›`, title prefixes or helper-defined tests exactly ([limits](playwright-test-list-selection-limits.md)).

## Rules

- Lowest Playwright is 1.63: 1.62 has the preprocess hook but no `--add-reporter`. Older or unknown versions run plain `--shard`.
- Yarn Plug'n'Play runs plain `--shard`: the reporter has no `node_modules` to load Playwright from.
- Every shard adds the `blob` reporter into a folder the Action owns (`PLAYWRIGHT_BLOB_OUTPUT_DIR`), unless the command names one, so finish always has reports to merge.
- Finish merges with the Playwright installed in `working-directory`, else `npx playwright@<plan version>` from npm.
- The Action code needs Node 18, the first with a global `fetch`; `main.js` checks it before any module loads.
- A unit is one spec file of one project at one repeat. Whole files keep serial groups whole without private fields.
- Intentional skips are allowed and not flagged; a run where every test skipped fails finish.
- One unnamed project (a config without `projects`) has the identity `''`; two or more unnamed or duplicate names are refused before any test.
- A filter belongs in `command`, which keys the history, so a filtered run has its own history.
- `command` may not contain `--shard`, `--workers`, `-j`, `--last-failed`, `--only-changed`, `--list`, `--no-deps` or `--`.
- The plan carries prepare's run attempt; finish ignores records of earlier attempts.
- Rollback (`enabled: false`) writes a status record per shard, so finish still fails on a failed or missing shard.
- The plan packs for the `workers` input. Whether that beats packing for one worker was an S6 question and is open.

## History publish

- `publish-history: auto` publishes from the default branch only. A cache entry saved on another ref is visible to that ref alone, so a branch would read its own stale entries.
- `true` also publishes from same-repository branches and pull requests, into their own cache scope. `false` never publishes.
- Fork pull requests and `pull_request_target` never publish; they read the base history like any run.
- A cache key is immutable, so a save onto an existing key changes nothing. Finish reads its key back: other bytes mean another writer won, and that entry joins the merge.
- An unreadable key is retried on the next attempt. After three attempts finish fails and the history is unchanged.
- Three attempts cover up to three writers racing for the same keys; a fourth simultaneous finish fails.
- A damaged newest entry is reported, and this run's merge is published over it: the job fails once, and the next run reads a healthy history.
- Keys are `psp-history-v2-<key>-<epoch>-<seq>`. A writer that saw no history starts a chain under the UTC date of its finish (YYYYMMDD); every other writer continues the epoch of the entry it read. Cold writers of one day meet on the first key and merge; a chain started on a later day never collides with old keys. Two cold writers on either side of midnight can drop one run's samples.

## Review cases (G2)

1. Plan binding (run, attempt, commit, key, fingerprint, shards, mode, snapshot sha): `tests/phases.test.js`. The corpus is checked in finish, since prepare runs before install: `tests/check.test.js`.
2. One decision before fan-out, strict shards, rollback: `tests/phases.test.js`, `tests/reporter-safety.test.js`, `tests/action-flow.test.js`.
3. Expected shards and attempts: `tests/check.test.js`, `tests/action-flow.test.js`.
4. Failed, cancelled and incomplete runs write nothing; keys separate runner, workers and command: `tests/history.test.js`, `tests/action-flow.test.js`, `tests/phases.test.js`.
5. Order, replay and permutation give one byte form: `tests/history.test.js`. The plan and the history read no clock; dates only expire entries.
6. Window behavior and the passing-attempt sample: `tests/history.test.js`, `tests/lifecycle.test.js`. Its bias shows in the predicted and measured columns of every summary.
7. Untrusted runs read and never write; forged plans are refused: `tests/phases.test.js`, `tests/action-flow.test.js`. A fork's finish may run code from its checkout (an installed Playwright, a `merge-config`) to merge the reports, and it never writes the history.

## Harvest acceptance rows

- P5 mismatched input: `reporter-safety` (other snapshot), `phases` (run refuses other bytes).
- P5 dropped reporter: `reporter-balance` (`--reporter=list`), `check` (no records).
- P6 and NSX P6 missing record: `action-flow` (missing record).
- P7 cold start: `action-flow` (cold), e2e cold.
- P8 faster, slow failure, slow retry: `history` (window), `lifecycle` (passing attempt).
- X2 racing publish: `action-flow` (racing writers), `phases` (compare-and-swap), e2e race.
- NSX P1 repeats and title collision: `reporter-balance` (repeat-each, repeat collision).
- NSX P2 serial groups, no private field: `reporter-balance` (fully parallel), `main` (field scan).
- NSX P8 damaged, failed, cancelled: `action-flow` (damaged entry, failed shard), `phases` (truncated record), `check` (not run).
- X1 damaged snapshot: `reporter-safety`.
- X2 delayed older run: `history` (delayed older run).
- Workers input: `reporter-balance` (plan sha under workers), `phases` (run arguments).
- Pinned snapshot and re-run: `phases` (run checks), `action-flow` (re-run shard).
- Max failures and latest attempt: `reporter-safety` (max failures), `check` (latest attempt).
- Summary and aggregate failures: `phases` (markdown), `check`.
- Rollback: `reporter-balance` (native leaves equal plain), `action-flow` (rollback).
- Trusted writer, provenance, fingerprint: `action-flow` (cold), `check` (fingerprint), `phases` (publish rule).
- Filtered run: its command keys its own history (`phases`); expiry: `history`.
- Zero samples: `history`.
- Runner and workers keys: `phases` (history key).
- No network: `reporter-safety` (guard).
- Plan line and summary row: `reporter-balance`, `phases`.
- Strict shards: `reporter-safety`.
- New-test estimate: `plan` (estimator), `history` (renamed test).
- Simulate: `phases` (simulate).
- Setup once and setup-free shards: `history` (setup median), `reporter-balance` (setup-free project).
- Deterministic search: `plan` (never above built-in), `reporter-safety` (slow clock).
- Dedupe: `action-flow` (finish re-run).
- Validation and save: `action-flow` (damaged entry).
- Deterministic bytes: `history` (either order).
- Exclusion through the public API: `reporter-balance`.
- Shape A `--test-list` files: not used (see Shape).
- `--add-reporter` with options in the environment: `command` (fold), `reporter-balance` (TypeScript config).
- Fork pull requests: `action-flow` (fork prepare balances, finish writes nothing).

## Remaining gaps

- A real fork pull request has not run; the fork rule is tested with event payloads.
- The couture-cast before and after (S9).
