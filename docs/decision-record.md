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

- Fixture: [nsxbet.md](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/qualification/nsxbet.md), [flakiness.md](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/qualification/flakiness.md), [comparison.md](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/qualification/comparison.md). On three shards a duration split cut the slowest shard from 12.4 s to 9.9 s.
- Harvest: [shard-balancer-harvest.md](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/research/shard-balancer-harvest.md). Its acceptance rows are listed below.
- Real suite: [baseline.md](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/measurements/baseline.md). couture-cast completes in a median 602 s, 87% of it outside the critical test span; balancing can win at most the 23 s assignment gap (3.6%).
- S6 stopped: the owner wants the Action proven on a synthetic suite, independent of couture-cast. The couture-cast before and after moves to S9.

## Shape

One JavaScript action that drops into the user's own job: a main step before the user's Playwright command, which adds `$PSP_ARGS`, and a post step after it. The main step pins one history snapshot to the workflow run and decides the mode from its bytes. `$PSP_ARGS` adds a bundled preprocess reporter with `--add-reporter` and leaves the user's config and command alone. The post step uploads the shard's run record and publishes its samples. An optional `finish` action proves that every test ran exactly once and writes the summary.

Shape A (per-shard `--test-list` files) is rejected: `--test-list` is a lossy selector that cannot pick out titles with `›`, title prefixes or helper-defined tests exactly ([limits](https://github.com/muratkeremozcan/playwright-smart-parallelization/blob/6164df685c3f13c5c6936d0473acfec10212e91f/docs/playwright-test-list-selection-limits.md)).

### Prepare dropped, finish optional (2026-10-17)

The three-phase interface (a prepare job, a run step that owned the Playwright command, a finish job) is replaced before v1. A prepare job and a plan output cost every user two extra jobs of wiring, and owning the command broke npm scripts, shell variables and checkouts of another commit. Each shard now pins the snapshot itself, as playwright-shard-balancer's restore action does but in a run artifact, and publishes its own samples by compare-and-swap, so the next run balances with no finish job. Finish stays as an optional check, because a test running exactly once across shards can only be proven after all of them, and a run without it still balances.

### Inputs derived, workers from Playwright (2026-10-18)

The `workers`, `runner-label` and `enabled` inputs are removed before v1, as is `publish-history: false`: each repeated configuration the user already has. Playwright resolves the workers from the config, the command and the CPUs, the runner is left out of the history key, and an `if:` on the step skips it. The main step runs before Playwright resolves the workers, so the count rides in the history: each shard publishes the count it resolved, and every shard plans for the count of its pinned snapshot, so shards that resolve different counts still plan one split. The inputs kept are the ones no context gives: `working-directory` for a workspace with several Playwright versions, `history-key` for suites the job id cannot tell apart, `publish-history: true` for a repository that runs its suite only on pull requests, and `github-token`, the one way an action receives the job token.

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
- `--last-failed` is refused before any test: Playwright filters after the split, where no reporter sees it, so a shard cannot prove the selection. The workaround is an `if:` that skips the Action's step for that command.
- Intentional skips are allowed and not flagged; a run where every test skipped fails finish.
- One unnamed project (a config without `projects`) has the identity `''`; two or more unnamed or duplicate names are refused before any test.
- The history key is working directory and `history-key`. Every shard of a job computes it alike, so shards on runners of other operating systems or architectures share one pin and one plan; the runner OS and architecture were part of it until 2026-10-18, which split such shards over two plans. The command is the user's and runs after the Action, so a filter shares the history; each test keeps its own samples. The runner, worker count, config path, environment and Playwright version share it too, so callers separate materially different setups with `history-key`.
- The Action runs on node24, so a self-hosted runner needs Actions runner v2.327.1 or later.
- The pin is a cache entry keyed by history key, job id and run id, never by the commit, so a workflow that checks out another commit plans the same on every shard and re-run. The cache is the one service of a run with a create-only write: of the saves of one key, exactly one creates it. The shard whose save created the pin plans from its own bytes, and every other shard reads the winner's bytes back, also the shards whose own saves lost.
- The pin was an artifact of the run until v1, on the assumption that an artifact name is unique in a run. Measured on GitHub, it is unique within one job only: eight shard jobs that upload one name at once create eight artifacts, `getArtifact` returns the highest id, and ids are not in the order of creation, so shards planned from different snapshots (run 39055263301). A re-run of the whole workflow also deletes every artifact of the run, the pin with it, so its shards failed before any test.
- Every cache call allows cross-OS archives, so a Windows shard computes the cache version of the rest and shares the pin; the toolkit still keys the version by compression, so shards split between zstd and gzip runners see two caches, which finish's one-snapshot check reports.
- The pin relies on every shard of one attempt seeing one cache: a pin entry that is created and read while the shards start is the last the cache would evict, and a job's cache service and mode are the same for all its shards. A pin deleted by hand while the shards start, or a job whose shards see the cache differently, can still split them over two plans; finish then fails on its one-mode and one-snapshot check.
- A re-run of the whole workflow deletes the run's artifacts, but the toolkit's listing and the REST listing still return them for minutes, and their downloads fail. Finish skips an artifact of an earlier attempt whose download answers 404 when a start marker of a later attempt of its job shows the job was re-run, and the pin skips such a record; a failed download of this attempt's, or any other failure, still fails the step.
- A pin another shard reserved and is still uploading is read again after waits up to 30 seconds; one never readable fails the shard before any test, since a shard on other bytes could run a test twice or not at all.
- A job that cannot both read and write the cache, by its cache mode, a runner without the cache service, or a cache that refuses its writes, runs native on every shard: without a create-only write no save can decide a pin, and Playwright's own split needs no shared bytes. A shard that cannot pin while shards of the run that already ran planned from a pin fails before any test instead. Such a job publishes nothing either, since a publish merges what the cache holds.
- Each shard keeps the pin it planned from in its run record, since the cache drops an entry unused for 7 days, or sooner under pressure, and a run can be re-run for 30. A shard that finds no pin, a re-run or a late shard of the first attempt, pins the bytes the shards of the run that already ran planned from, the newest attempt of each, or no history when they ran native, and fails before any test when they planned from different bytes or no record holds them. A re-run with no record either, because a re-run of the whole workflow deleted them or the retention expired them, pins afresh only when the repository keeps artifacts for the 30 days a run can be re-run, or the run is younger than the retention (its age from the runs API), since only then does a missing record prove that no kept shard planned from a lost pin.
- Finish is the only cross-shard proof. A run without it still balances; each shard job's own status stays the caller's.
- Each shard's main step uploads a start marker whose token its record carries. Finish fails when a shard job started in an attempt and left no record, unless every shard it could have been was re-run later, so an earlier record never stands for a re-run that failed before the reporter, was cancelled or lost its upload. A shard that was not re-run keeps its earlier record. A shard whose marker upload fails after retries stops before any test, since finish could not see it; its red job is then the only signal.
- The start marker uploads while the shard reads its pin, and the main step waits for both, so a shard that fails on its pin still leaves its marker. The newest history restores while the shard looks for the pin, so a shard that pins waits for the slower of the two only.
- The post step uploads the run record while it publishes the samples; finish downloads the records and markers 16 at a time, while it reads the jobs API.
- `$PSP_ARGS` names a copy of the reporter in a `node_modules` folder of the job's temp folder: Playwright compiles a reporter outside `node_modules` with Babel first, which cost each shard about half a second on a hosted runner.
- A disabled shard leaves `$PSP_ARGS` empty and uploads a status record, so finish tells it from shards that never ran.
- A run with no start marker at all had its Action step skipped by an `if:` on every shard, since the main step uploads its marker first or fails its job; finish reports `not checked` and passes, so turning balancing off needs no change to the finish job. A start marker with no record still fails it.
- The plan packs for the worker count of the pinned snapshot, the count the shard that published it resolved, so every shard plans the same on any runner. A shard whose Playwright resolved another count says so in one line and keeps the plan; Playwright runs it with its own count.

## History publish

- `publish-history: auto` publishes from the default branch only. A cache entry saved on another ref is visible to that ref alone, so a branch would read its own stale entries.
- `true` also publishes from same-repository branches and pull requests, into their own cache scope.
- Fork pull requests and `pull_request_target` never publish; they read the base history like any run.
- Every shard publishes the samples of its passing tests under the run's id, also when another test failed; a failed attempt adds no sample. A test has one sample per run whichever shard ran it; a setup test several shards ran keeps the smallest. This replaces the one trusted writer of the original contract, so the next run balances with no finish job.
- A cache key is immutable, so a save onto an existing key changes nothing, and a save creates its key only when no other writer reserved it. A save that created the key is published with no read-back. A shard whose save did not create the key reads it back: other bytes mean another writer won, that entry joins the merge, and the shard tries the next key at once, since every entry holds the one before it.
- A shard that holds the bytes of the newest entry, such as the entry its pin holds, reads only the newest key and downloads no entry it already holds.
- An unreadable key is retried on the next attempt. Each lost attempt lets one other writer through, so a shard makes `max(8, shards + 4)` attempts; after the last it warns and the history is unchanged.
- A damaged newest entry is reported, and the shard's merge is published over it, so the next run reads a healthy history.
- Keys are `psp-history-v2-<key>-<epoch>-<seq>`. A writer that saw no history starts a chain under the UTC date of its write (YYYYMMDD); every other writer continues the epoch of the entry it read. Cold writers of one day meet on the first key and merge; a chain started on a later day never collides with old keys. Two cold writers on either side of midnight can drop one shard's samples.

## Review cases (G2)

1. One snapshot per run and job, never per commit: `tests/units.test.js` (pin), `tests/action-flow.test.js` (head commit). The corpus is checked in finish: `tests/check.test.js`.
2. One decision from the pinned bytes, strict shards, a disabled run: `tests/units.test.js`, `tests/reporter-safety.test.js`, `tests/action-flow.test.js`.
3. Expected shards and attempts: `tests/check.test.js`, `tests/action-flow.test.js`.
4. A failed test writes only the samples of the tests that passed; keys separate runner and history key: `tests/history.test.js`, `tests/action-flow.test.js`, `tests/units.test.js`.
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
- Workers from Playwright: `reporter-balance` (one plan under different resolved counts), `history` (the count of the newest run), e2e workers legs.
- Pinned snapshot and re-run: `units` (the pin), `action-flow` (re-run shard), e2e re-run.
- Max failures and latest attempt: `reporter-safety` (max failures), `check` (latest attempt).
- Summary and aggregate failures: `units` (markdown), `check`.
- Disabled: `reporter-balance` (native leaves equal plain), `action-flow` (disabled run).
- Trusted writer, provenance, fingerprint: `action-flow` (cold), `check` (fingerprint), `units` (publish rule).
- Filtered run: its tests keep their own samples in the shared history (`action-flow`, shell variables); expiry: `history`.
- Zero samples: `history`.
- One key across runners: `units` (history key).
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
- Re-runs of one job and of the whole workflow ran on GitHub once each in a probe of the services; the e2e workflow proves a re-run of the whole workflow, and re-runs of some jobs are tested with attempts in the local model.
- No stable release is cut yet; the release workflow has not published a tag.
- The couture-cast before and after (S9).
