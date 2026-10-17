---
title: 'S8 fixes from the first consumer (pw-parallel-test)'
type: 'bugfix'
ticket: 'S8'
created: '2026-10-17'
status: 'built'
baseline_revision: '063aba8'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** pw-test followed the README with Action 063aba8 and hit 12 issues: missing permissions, no blob reporter, unclear publish rule, modes and history, finish fetching Playwright from npm, no Node guard, a browser install every shard needs, and rollback reporting coverage it never checked.

**Approach:** Fix behavior first; where a fact must be documented, one README line. Every behavior fix gets a test that fails on revert, and the e2e on `fixtures/consumer` asserts what it should have caught.

## Boundaries & Constraints

**Always:** the user's config stays untouched; public Playwright API only; README stays short; no attribution lines; Codex review before push.

**Never:** new runtime npm dependencies; changing the run phase's Node or PATH; touching couture-cast.

## I/O & Edge-Case Matrix

| # | Issue | Fix | Test that catches it |
|---|---|---|---|
| 1 | finish needs `actions: read` | README `permissions` block; the summary names the 403 and the missing permission | unit: jobs API 403 names `actions: read`; e2e asserts the overhead was measured |
| 2 | no blob reporter, nothing to merge | run adds `blob` to its `--add-reporter` value and points `PLAYWRIGHT_BLOB_OUTPUT_DIR` at an Action-owned folder; the `blob-report` input goes | unit: argv and env; e2e command without `--reporter=blob` still produces a merged report |
| 3 | publish rule unclear | README line: only default-branch runs write history | doc |
| 4 | "native" below 1.63 is disabled | README line names plain `--shard` with no coverage check | doc |
| 5 | mode not machine-readable after the run | prepare outputs `mode` and `reason` and writes them to its job summary; finish outputs `mode`, `coverage` (`ok`, `failed`, `not checked`) and `history` | unit; e2e asserts the finish outputs in every leg |
| 6 | blob artifact names | artifacts named `blob-report-<key12>-<shard>-attempt-<n>`, matching `blob-report-*`; one README line | unit names; e2e asserts the name |
| 7 | rollback reports coverage OK | disabled mode reports coverage `not checked` in the output and the summary | unit; e2e rollback asserts `not checked` |
| 8 | cache eviction cold-starts a quiet repo | README line | doc |
| 9 | history key undocumented | README line: command, workers, runner label and `history-key`; shard count is free to change | doc |
| 10 | npx from npm, merge config ignored | finish merges with the Playwright installed in `working-directory` when present, else `npx playwright@<version>`; new input `merge-config` passed as `--config` | unit: local install chosen, config passed |
| 11 | no Node guard | `main.js` fails fast with a clear message below the lowest Node the Action code supports; CI runs the Action phases on that Node | unit; e2e leg on the lowest Node |
| 12 | browser install on every shard | README example installs browsers with a one-line note to drop it for browser-free suites | doc |

</frozen-after-approval>

## Code Map

- `lib/run.js` `setup`, `command`, `shardArgv` in `lib/command.js`: add the blob reporter and its env; drop `blob-report`.
- `lib/identity.js` `artifactNames`: blob artifact names.
- `lib/finish.js` `check`, `report`, `conclude`, `trust`: outputs, coverage state, local merge, merge config.
- `lib/summary.js` `fetchJobs`, `markdown`: 403 message, coverage line.
- `lib/prepare.js`: `reason` output and job summary.
- `scripts/render-action.js`: inputs and outputs; `action.yml` is rendered.
- `main.js`: Node guard.
- `.github/workflows/e2e-pipeline.yml`, `test.yml`: assertions and the lowest-Node leg.
- `README.md`: Usage only.

## Tasks & Acceptance

**Execution:**
- [x] each matrix row, code and test in the files above
- [x] `docs/decision-record.md`: one line each for the blob reporter and the merge source

**Acceptance Criteria:**
- Given the e2e workflow, when it runs, then every leg asserts the finish outputs, the merged report and the blob artifact names, the rollback leg asserts coverage `not checked`, and one leg runs prepare and finish on the lowest supported Node.

## Implementation Notes

## Plan Change Log

- 2026-10-17: lowest Node is 20: finish runs Playwright's CLI to merge the reports, and Playwright 1.64 needs Node 20. The cold e2e leg runs prepare and finish on Node 20.
- 2026-10-17: finish also outputs `overhead-ms`, which the e2e legs assert to prove the jobs API was read (row 1).
- 2026-10-17: disabled mode adds no reporter and no blob variable (Playwright below 1.63 has no `--add-reporter`), so rollback has no merged report; balanced and native skip the added blob reporter when the command names one.
- 2026-10-17: every Node step after the first reads the inputs from a file the first step writes, so the plan appears once in the log; the token is passed to the jobs-API step only.
- 2026-10-17: download-artifact@v8 puts a single pattern match straight into the path; finish reads both layouts (unchanged).

## Review Triage Log

## Verification

**Commands:**
- `npm run validate`: expected exit 0
