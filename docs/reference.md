# Reference

Facts about the Action that the README example does not need. Every input is in [`action.yml`](../action.yml).

## Outputs

- `prepare` outputs `mode` (`balanced`, `native` or `disabled`) and `reason`.
- `finish` outputs `mode`, `coverage` (`ok`, `failed` or `not checked`), `history` (`published`, `unchanged` or `failed`) and `overhead-ms`.

## Reports

- Each shard uploads its blob report as `blob-report-<key>-<shard>-attempt-<n>`, so `pattern: blob-report-*` downloads them.
- A blob reporter in your config writes into the Action's folder too, and `finish` merges it.
- With `enabled: false` the Action adds no reporter and uploads what your config's blob reporter writes: `blob-report` beside the config, or the folder `PLAYWRIGHT_BLOB_OUTPUT_DIR` or `PLAYWRIGHT_BLOB_OUTPUT_FILE` names.
- `finish` merges with the Playwright installed in `working-directory`, else `npx playwright@<version>`.
- `merge-config` picks the merge reporters and needs Playwright installed in the finish job.

## History

- The history is keyed by command, working directory, workers, runner label and `history-key`; the shard count can change freely.
- It lives in the Actions cache, which drops entries unused for 7 days, so a quiet repo starts cold again.

## Runner

- The Action needs Node 20 or later on the runner.
