/**
 * Asserts every qualification result against fresh evidence. The evidence comes from
 * `PSP_FLK_EVIDENCE` (a file written by `npm run qualify:flakiness`) or, when that is unset, from
 * a collection run by this file, which takes several minutes.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { PROBES } = require('../scenarios/network');
const { collectEvidence } = require('../proofs');
const { EXPECTED_EXTRAS, EXPECTED_PROOFS, EXPECTED_ROWS, ROW_SUBJECTS } = require('../expected');

let evidence;
const row = (id) => {
  const found = evidence.rows.find((candidate) => candidate.id === id);
  assert.ok(found, `no row ${id}`);
  return found.evidence;
};

before(async () => {
  evidence = process.env.PSP_FLK_EVIDENCE
    ? JSON.parse(fs.readFileSync(process.env.PSP_FLK_EVIDENCE, 'utf8'))
    : await collectEvidence({ requireOsBlock: process.env.PSP_REQUIRE_OS_NETWORK_BLOCK === '1' });
});

describe('results', () => {
  test('the evidence has exactly the expected rows', () => {
    assert.deepStrictEqual(
      evidence.rows.map((r) => r.id).sort(),
      Object.keys(EXPECTED_ROWS).sort()
    );
  });

  for (const [id, expected] of Object.entries(EXPECTED_ROWS)) {
    test(`${id} is ${expected}`, () => {
      const found = evidence.rows.find((candidate) => candidate.id === id);
      const accepted = id === 'net.os-block' && found.status === 'skipped' ? 'skipped' : expected;
      assert.strictEqual(found.status, accepted);
    });
  }

  test('only the expected rows are about glue code or about Playwright itself', () => {
    const marked = Object.fromEntries(
      evidence.rows.filter((r) => r.subject !== 'engine').map((r) => [r.id, r.subject])
    );
    assert.deepStrictEqual(marked, ROW_SUBJECTS);
  });

  test('the extra cases roll up as expected', () => {
    const actual = Object.fromEntries(evidence.extras.map((e) => [e.id, e.status]));
    assert.deepStrictEqual(actual, EXPECTED_EXTRAS);
  });

  test('the proofs roll up as expected', () => {
    const actual = Object.fromEntries(evidence.proofs.map((p) => [p.number, p.status]));
    assert.deepStrictEqual(actual, EXPECTED_PROOFS);
  });

  test('versions are recorded, with a Playwright the balanced mode supports', () => {
    assert.match(evidence.versions.engine, /^@flakiness\/playwright@\d+\.\d+\.\d+/);
    assert.match(evidence.versions.playwright, /^\d+\.\d+\.\d+/);
    assert.match(evidence.versions.node, /^v\d+/);
    const [major, minor] = evidence.versions.playwright.split('.').map(Number);
    assert.ok(major > 1 || minor >= 62, evidence.versions.playwright);
  });
});

describe('execution outcomes', () => {
  test('no row records a leaf that skipped or never ran', () => {
    for (const found of evidence.rows) {
      const kinds = found.evidence.kinds || {};
      assert.strictEqual(kinds['not-executed'], undefined, found.id);
      assert.strictEqual(
        (found.evidence.coverageViolations || {})['not-executed'],
        undefined,
        found.id
      );
    }
  });

  test('no balance run records one either', () => {
    for (const entry of evidence.balance) {
      for (const strategy of [
        entry.native,
        entry.engine,
        entry.nativeParallel,
        entry.engineParallel,
      ]) {
        assert.strictEqual(strategy.violations['not-executed'], undefined);
      }
    }
  });
});

describe('proof 1: exactly once', () => {
  test('the balanced runs cover every leaf once, and the plan used the timings file', () => {
    for (const id of ['1.balanced', '1.repeat-each', '1.fully-parallel']) {
      assert.deepStrictEqual(row(id).coverageViolations, {}, id);
      assert.strictEqual(row(id).plan.hinted, row(id).plan.tests, id);
    }
  });

  test('titles that tell no test-list line apart cost nothing', () => {
    assert.deepStrictEqual(row('1.prefix-titles').coverageViolations, {});
    const siblings = row('1.sibling-suites');
    assert.deepStrictEqual(siblings.splitGroups, []);
    assert.strictEqual(siblings.leavesListed, 8);
    assert.strictEqual(siblings.leavesRun, 8);
  });
});

describe('proof 2: serial groups and dependencies', () => {
  test('no row splits a serial group, with history, without and under fullyParallel', () => {
    for (const id of ['2.cold', '2.history', '2.history-3', '2.fully-parallel']) {
      assert.deepStrictEqual(row(id).splitGroups, [], id);
      assert.deepStrictEqual(row(id).failedShards, [], id);
    }
  });

  test('serial groups retry and end exactly as under native sharding', () => {
    const outcomes = row('2.serial-outcomes');
    assert.ok(outcomes.leavesWithRetries > 0);
    assert.deepStrictEqual(outcomes.coverageViolations, { native: {}, balanced: {} });
    assert.strictEqual(outcomes.sameOutcomesAsNative, true);
  });

  test('a shard with no test that needs setup does not run it, and setup runs once for them', () => {
    const aware = row('2.setup-aware');
    assert.strictEqual(aware.shardsRunningSetupWithoutDependents, 0);
    assert.ok(aware.shards.some((shard) => shard.dependentLeaves > 0));
    assert.ok(
      aware.shards.some((shard) => shard.independentLeaves > 0 && shard.dependencyLeaves === 0)
    );
    assert.deepStrictEqual(Object.values(aware.dependencyExecutions), [1, 1]);
    assert.deepStrictEqual(aware.dependencyExecutions, aware.nativeDependencyExecutions);
  });

  test('setup and teardown ran in each shard that needs them in every run, and nothing skipped', () => {
    const dependencies = row('2.dependencies');
    assert.strictEqual(dependencies.runsChecked, 4);
    assert.deepStrictEqual(dependencies.dependencyViolations, []);
  });
});

describe('proof 3: filters', () => {
  test('--grep and --project select fewer tests than the suite and run each once', () => {
    const full = row('1.balanced').plan.tests;
    for (const id of ['3.grep', '3.project']) {
      assert.deepStrictEqual(row(id).coverageViolations, {}, id);
      assert.ok(row(id).plan.tests < full, id);
      assert.strictEqual(row(id).plan.hinted, row(id).plan.tests, id);
    }
  });
});

describe('proof 4: one assignment', () => {
  test('every shard, repeat, worker count and clock gets the same plan', () => {
    const plan = row('4.deterministic-plan');
    assert.strictEqual(plan.distinctPlacements, 1);
    assert.strictEqual(plan.distinctPlanLines, 1);
    assert.deepStrictEqual(plan.runs, ['first', 'again', 'four workers', 'slow clock']);
  });

  test('the reporter replaces the native split, and listing a shard shows what it runs', () => {
    const applied = row('4.applied-by-reporter');
    assert.strictEqual(applied.balancedDiffersFromNative, true);
    assert.strictEqual(applied.reporterWithoutTimingsEqualsPlainNative, true);
    assert.strictEqual(row('4.list-matches-run').sameAsRun, true);
    assert.ok(row('4.list-matches-run').leavesPerShard.every((count) => count > 0));
  });
});

describe('proof 5: damaged and mismatched input', () => {
  const outcomes = (id) => row(id).outcomes.map((outcome) => outcome.outcome);

  test('a file that is not a readable report fails every shard before any test', () => {
    assert.deepStrictEqual(outcomes('5.truncated'), Array(3).fill('fails before any test'));
    assert.deepStrictEqual(outcomes('5.version'), Array(3).fill('fails before any test'));
    assert.deepStrictEqual(outcomes('5.string-durations'), ['fails before any test']);
    for (const outcome of row('5.truncated').outcomes) assert.match(outcome.message, /Error: /);
  });

  test('a project that is not a git repository fails every shard before any test', () => {
    const noGit = row('5.no-git-repository');
    assert.strictEqual(noGit.outcome, 'fails before any test');
    assert.deepStrictEqual(noGit.exits, [1, 1]);
    assert.match(noGit.message, /failed to fetch commit info/);
  });

  test('a report that knows no test gives a complete plan of estimates, with no warning', () => {
    for (const id of ['5.null-tests', '5.stale-ids']) {
      for (const outcome of row(id).outcomes) {
        assert.strictEqual(outcome.outcome, 'complete plan', id);
        assert.strictEqual(outcome.hinted, 0, id);
        assert.strictEqual(outcome.silent, true, id);
      }
    }
  });

  test('durations of zero give a complete plan on hints that carry no information', () => {
    const [zero] = row('5.zero-durations').outcomes;
    assert.strictEqual(zero.outcome, 'complete plan');
    assert.strictEqual(zero.hinted, zero.tests);
    assert.match(zero.loads, /^1=0ms, 2=0ms$/);
    assert.strictEqual(zero.silent, true);
  });

  test('two valid timings files split the shards without any error', () => {
    const mismatch = row('5.mismatched-timings');
    assert.ok(mismatch.coverageViolations.duplicate > 0);
    assert.ok(mismatch.coverageViolations.missing > 0);
    assert.deepStrictEqual(mismatch.exits, [0, 0]);
    assert.strictEqual(mismatch.planLinesDiffer, true);
  });

  test('a command line that replaces the reporters on one shard splits the run silently', () => {
    const dropped = row('5.reporter-dropped');
    assert.ok(dropped.coverageViolations.duplicate > 0);
    assert.ok(dropped.coverageViolations.missing > 0);
    assert.deepStrictEqual(dropped.exits, [0, 0]);
    assert.deepStrictEqual(dropped.planPrintedPerShard, [true, false]);
  });

  test('the same override on every shard gives the native split, with no plan and no error', () => {
    const overridden = row('5.reporter-overridden');
    assert.deepStrictEqual(overridden.coverageViolations, {});
    assert.deepStrictEqual(overridden.planPrintedPerShard, [false, false]);
    assert.strictEqual(overridden.splitIsNative, true);
    assert.strictEqual(overridden.silent, true);
  });

  test('a damaged timings file on one shard fails that shard before any test', () => {
    const damaged = row('x1.damaged-shard-timings');
    assert.deepStrictEqual(damaged.exits, [0, 1]);
    assert.deepStrictEqual(damaged.leavesRunPerShard.slice(1), [0]);
    assert.ok(damaged.leavesRunPerShard[0] > 0);
    assert.strictEqual(damaged.kinds.duplicate, undefined);
    assert.match(damaged.message, /failed to generate balanced shard/);
  });
});

describe('proof 6: exit codes, retries and artifacts', () => {
  test('the shards that exit non-zero are those with a failed test, as under native sharding', () => {
    const codes = row('6.exit-codes');
    assert.ok(codes.failedShards.length > 0);
    assert.deepStrictEqual(codes.failedShards, codes.shardsWithFailedTest);
    assert.strictEqual(codes.unexpectedEngine, codes.unexpectedNative);
  });

  test('retries give the native number of flaky tests', () => {
    const retries = row('6.retries');
    assert.ok(retries.flakyEngine > 0);
    assert.strictEqual(retries.flakyEngine, retries.flakyNative);
  });

  test('attachments, traces, blob reports and the Flakiness report are complete', () => {
    const artifacts = row('6.artifacts');
    assert.strictEqual(artifacts.traceFiles, 6);
    assert.strictEqual(artifacts.noteAttachments, 6);
    assert.strictEqual(artifacts.blobReports, 2);
    assert.strictEqual(artifacts.mergedTotal, artifacts.shardTotal);
    assert.strictEqual(artifacts.flakinessReports, 2);
    assert.strictEqual(artifacts.testsInFlakinessReports, artifacts.testsExecuted);
    assert.strictEqual(artifacts.attachmentReferencesByName.note, 6);
    assert.strictEqual(artifacts.attachmentsStored, artifacts.attachmentReferences);
  });

  test('merging the blob reports of fewer shards succeeds in Playwright', () => {
    const blob = row('6.missing-blob');
    assert.strictEqual(blob.exit, 0);
    assert.ok(blob.mergedTotal < blob.completeTotal);
  });

  test('building history from the report of one shard succeeds with fewer tests', () => {
    const missing = row('6.missing-shard-report');
    assert.strictEqual(missing.buildExit, 0);
    assert.ok(missing.testsWithOneReport < missing.testsWithCompleteInput);
    assert.strictEqual(missing.unreadableInputExit, 1);
  });
});

describe('proof 7: no history, new and renamed tests', () => {
  test('with no history the whole suite runs, with an empty timings file or none', () => {
    const cold = row('7.cold');
    assert.deepStrictEqual(cold.emptyTimings.coverageViolations, {});
    assert.strictEqual(cold.emptyTimings.plan.hinted, 0);
    assert.deepStrictEqual(cold.noTimingsFile.coverageViolations, {});
    assert.strictEqual(cold.noTimingsFile.planPrinted, false);
  });

  test('the first run, with a timings file that does not exist yet, fails every shard', () => {
    const first = row('7.missing-timings-file');
    assert.deepStrictEqual(first.exits, [1, 1]);
    assert.deepStrictEqual(first.testsListedPerShard, [0, 0]);
    assert.strictEqual(first.failsBeforeAnyTest, true);
    assert.match(first.message, /cannot read shardBalancing\.timingsFile/);
  });

  test('a renamed test and a new file run, are visible as estimates, and enter history', () => {
    const renamed = row('7.new-renamed');
    assert.deepStrictEqual(renamed.coverageViolations, {});
    assert.strictEqual(renamed.testsWithoutHint, 6);
    assert.strictEqual(renamed.testsWithoutHintAfterMerge, 0);
  });
});

describe('proof 8: history', () => {
  test('a damaged history or report makes build fail and leaves the file alone', () => {
    const damaged = row('8.damaged-history');
    for (const input of [damaged.damagedHistory, damaged.damagedReport]) {
      assert.strictEqual(input.exit, 1);
      assert.strictEqual(input.outputUnchanged, true);
    }
  });

  test('a failed run lowers no project, a slow failure raises every project, a cancelled run lowers none', () => {
    const quick = row('8.failed-run');
    for (const project of ['chromium', 'firefox']) {
      assert.ok(quick.pricesAfterMs[project] >= quick.pricesBeforeMs[project] * 0.9, project);
    }
    const slow = row('8.failed-run-slow');
    for (const project of ['chromium', 'firefox']) {
      assert.ok(slow.pricesAfterMs[project] > slow.pricesBeforeMs[project] * 5, project);
    }
    const cancelled = row('8.cancelled-run');
    assert.strictEqual(cancelled.reportWritten, true);
    assert.strictEqual(cancelled.exit, 130);
    assert.ok(cancelled.cancelledAttemptMs < 900);
    for (const project of ['chromium', 'firefox']) {
      assert.ok(cancelled.pricesAfterMs[project] >= cancelled.pricesBeforeMs[project] * 0.9);
    }
  });

  test('a test ten times faster leaves the price of every project where it was', () => {
    const faster = row('8.faster-test');
    for (const project of ['chromium', 'firefox']) {
      assert.ok(faster.newRunMs < faster.pricesBeforeMs[project] / 5, project);
      assert.strictEqual(faster.pricesAfterMs[project], faster.pricesBeforeMs[project], project);
    }
  });

  test('a test stored once for two equally slow projects loses the price of one to a short run', () => {
    const equal = row('8.equal-durations');
    assert.deepStrictEqual(equal.pricesBeforeMs, { chromium: 200, firefox: 200 });
    assert.deepStrictEqual(equal.pricesAfterMs, { chromium: 200, firefox: equal.quickRunMs });
  });

  test('history rebuilt from a window of recent passing runs adapts and ignores a failed run', () => {
    const windowed = row('8.window-rebuild');
    assert.ok(windowed.durationInFasterWindowMs < windowed.durationBeforeMs / 5);
    assert.ok(windowed.durationWithFailedRunInWindowMs > windowed.durationBeforeMs * 5);
    assert.ok(windowed.durationWithFailedRunLeftOutMs <= windowed.durationBeforeMs * 1.05);
    assert.ok(windowed.durationWithSlowPassingRunInWindowMs >= windowed.durationBeforeMs * 0.95);
  });

  test('two runs publishing in the opposite order lose updates, and the file names no run', () => {
    const race = row('x2.racing-publish');
    assert.ok(race.updatesLost > 0);
    assert.strictEqual(race.carriesRunIdentity, false);
  });
});

describe('network audit', () => {
  test('the guard catches every kind of attempt', () => {
    assert.ok(row('net.guard-control').attempts.length >= 4);
  });

  test('a balanced run with a credential in the environment makes no attempt', () => {
    const run = row('net.balanced-run');
    assert.strictEqual(run.attempts, 0);
    assert.deepStrictEqual(run.exits, [0, 0]);
    assert.strictEqual(run.credentialsInEnvironment, true);
    assert.deepStrictEqual(run.unexpectedPrograms, []);
    assert.ok(run.playwrightWorkers > 0);
    for (const name of Object.keys(run.spawnedPrograms)) assert.ok(PROBES.has(name), name);
  });

  test('the timings command makes no attempt and starts nothing', () => {
    const build = row('net.timings-build');
    assert.strictEqual(build.attempts, 0);
    assert.deepStrictEqual(build.spawnedPrograms, {});
  });

  test('with the upload left on, the reporter reaches for the vendor', () => {
    const upload = row('net.upload-control');
    assert.ok(upload.attempts > 0);
    assert.deepStrictEqual(upload.attemptTargets, ['https://vendor.invalid/api/upload/start']);
  });

  test('a reporter that runs curl is rejected', () => {
    const mutated = row('net.mutation-control');
    assert.strictEqual(mutated.mutatedStatus, 'fail');
    assert.deepStrictEqual(mutated.unexpectedPrograms, ['curl']);
  });

  test('the run and the build give the same result under an OS-level network block', () => {
    const block = evidence.rows.find((r) => r.id === 'net.os-block');
    if (block.status === 'skipped') return;
    assert.strictEqual(block.evidence.samePlanAsOpen, true);
    assert.strictEqual(block.evidence.sameTimingsAsOpen, true);
    assert.deepStrictEqual(block.evidence.exits, [0, 0]);
  });
});

describe('balance', () => {
  test('native sharding and the engine run every leaf once, for two and three shards', () => {
    assert.deepStrictEqual(
      evidence.balance.map((entry) => entry.shards),
      [2, 3]
    );
    for (const entry of evidence.balance) {
      for (const strategy of [
        entry.native,
        entry.engine,
        entry.nativeParallel,
        entry.engineParallel,
      ]) {
        assert.deepStrictEqual(strategy.violations, {}, `${entry.shards} shards`);
      }
    }
  });

  test('on three shards the balanced split finishes sooner than the native one', () => {
    const three = evidence.balance.find((entry) => entry.shards === 3);
    assert.ok(three.engine.slowestVsNative < 0);
    assert.ok(three.engine.imbalance < three.native.imbalance);
  });

  test('on two shards, where native sharding is already even, the engine stays close to it', () => {
    const two = evidence.balance.find((entry) => entry.shards === 2);
    assert.ok(two.engine.slowestVsNative < 0.1);
  });
});

describe('footprint', () => {
  test('is measured against a plain native run', () => {
    const { install, playwright, timingsCommand, artifactBytes, reportContent } =
      evidence.footprint;
    assert.ok(install.packages >= 1);
    assert.strictEqual(playwright.runs, 5);
    for (const side of [playwright.plain, playwright.reporter]) {
      assert.ok(side.wallMinMs <= side.wallMs && side.wallMs <= side.wallMaxMs);
    }
    assert.ok(playwright.reporter.mainRssKb > 0 && playwright.plain.mainRssKb > 0);
    assert.ok(timingsCommand.peakRssKb.buildOne > timingsCommand.peakRssKb.bareNode);
    assert.ok(artifactBytes.flakinessFolder >= artifactBytes.flakinessReport);
    assert.ok(reportContent.sourceFiles > 0 && reportContent.cpuSamples > 0);
  });

  test('the programs the reporter starts are those its source starts', () => {
    for (const name of Object.keys(evidence.footprint.probeProcesses)) {
      assert.ok(PROBES.has(name), name);
    }
  });
});
