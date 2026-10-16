# Engine comparison

The two engines side by side, built from the committed evidence of each: `nsxbet-evidence.json` and `flakiness-evidence.json`. Every table below is generated from those files and a test compares it with them. The verdicts are in [nsxbet.md](nsxbet.md) (does not qualify) and [flakiness.md](flakiness.md) (qualifies with named gaps), and the rows are explained there.

## Proofs and cases

A proof fails when any of its engine rows fails.

| Proof | What the proof asks                                                            | NSXBet | Flakiness |
| ----- | ------------------------------------------------------------------------------ | ------ | --------- |
| P1    | Every selected leaf runs in exactly one shard                                  | fail   | pass      |
| P2    | Serial groups and setup or teardown dependencies keep their behavior           | fail   | pass      |
| P3    | Filters and project selection mean the same as before                          | pass   | pass      |
| P4    | Every shard uses one assignment                                                | pass   | pass      |
| P5    | Corrupt or mismatched input cannot split shards                                | pass   | fail      |
| P6    | Exit codes, retries, traces and reports stay valid                             | fail   | fail      |
| P7    | A run with no history is complete, new tests are kept                          | pass   | pass      |
| P8    | Failed or cancelled runs and a damaged history file never replace good history | fail   | fail      |
| X1    | One shard with a damaged timing file                                           | fail   | pass      |
| X2    | Two runs racing to publish history                                             | fail   | fail      |

## Rows that end differently

Rows that both engines have under one id and that ended differently. Rows only one engine has are in its own document.

| Row                 | NSXBet | Flakiness |
| ------------------- | ------ | --------- |
| `1.repeat-each`     | fail   | pass      |
| `1.prefix-titles`   | fail   | pass      |
| `8.damaged-history` | fail   | pass      |
| `8.failed-run`      | fail   | pass      |
| `8.cancelled-run`   | fail   | pass      |
| `2.cold`            | fail   | pass      |
| `2.history`         | fail   | pass      |

## Balance

Slowest shard against the engine's own native run of the same fixture, one worker per shard. NSXBet needs its shim to avoid splitting serial groups, and the row without the shim lists the violations. Flakiness is shown with Playwright's per-file units, which is how Playwright shards by default, and with `fullyParallel`, against a native run of the same units.

| Shards | Engine    | Strategy                                    | Slowest ms | Against its native run | Imbalance | Violations     | Native ms |
| ------ | --------- | ------------------------------------------- | ---------- | ---------------------- | --------- | -------------- | --------- |
| 2      | NSXBet    | native `--shard`                            | 13877      | baseline               | 0.1%      | none           | 13877     |
| 2      | NSXBet    | engine                                      | 14497      | +4.5%                  | 3.0%      | serial-split 2 | 13877     |
| 2      | NSXBet    | engine with serial groups kept whole (shim) | 14214      | +2.4%                  | 1.1%      | none           | 13877     |
| 2      | Flakiness | native `--shard`                            | 13906      | baseline               | 0.2%      | none           | 13906     |
| 2      | Flakiness | engine                                      | 14130      | +1.6%                  | 0.1%      | none           | 13906     |
| 2      | Flakiness | engine, fullyParallel                       | 14119      | +1.6%                  | 0.0%      | none           | 13893     |
| 3      | NSXBet    | native `--shard`                            | 12411      | baseline               | 30.5%     | none           | 12411     |
| 3      | NSXBet    | engine                                      | 9847       | -20.7%                 | 2.2%      | serial-split 2 | 12411     |
| 3      | NSXBet    | engine with serial groups kept whole (shim) | 9713       | -21.7%                 | 1.9%      | none           | 12411     |
| 3      | Flakiness | native `--shard`                            | 12385      | baseline               | 30.1%     | none           | 12385     |
| 3      | Flakiness | engine                                      | 9770       | -21.1%                 | 2.4%      | none           | 12385     |
| 3      | Flakiness | engine, fullyParallel                       | 9753       | -21.4%                 | 2.3%      | none           | 12413     |

## Footprint

What each engine adds to a pipeline. NSXBet runs as a command before the shards and leaves the shard runs as they are. Flakiness runs inside every shard.

| Measure                                     | NSXBet                                                           | Flakiness                                    |
| ------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Packages installed                          | 59                                                               | 1                                            |
| `node_modules` size                         | 9.3 MiB                                                          | 1.3 MiB                                      |
| Where it runs                               | A planning command before the shards; the shards run as they are | Inside every shard, as a Playwright reporter |
| Time added to a shard run                   | none                                                             | 79 ms (+0.7%)                                |
| Planning step, once per run                 | 154 ms (`assign` with history)                                   | none, each shard plans for itself            |
| Peak memory added to the Playwright process | none                                                             | 5.8 MiB                                      |
| Largest artifact per shard                  | 1.5 KiB timing artifact                                          | 39.2 KiB report folder                       |
| Network audit                               | pass; mutation control pass                                      | pass; mutation control pass                  |

## Reading the comparison

NSXBet reaches an even split on three shards only when its shim keeps serial groups whole. Without the shim it is as fast and splits serial groups. Flakiness reaches a comparable split on three shards with no violation and no glue code, because it balances the units Playwright already shards by. On two shards the fixture is already even under native sharding, and neither engine improves on it. The history side is weak in both: neither checks that every shard report arrived, and two racing publishes lose updates in both. The remaining gaps of Flakiness are about the input of its shards and about the maximum rule of its history, and the [smallest remaining integration gap](flakiness.md#smallest-remaining-integration-gap) lists the pieces that close them.
