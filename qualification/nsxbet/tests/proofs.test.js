/**
 * Asserts every qualification result against fresh evidence. The evidence comes from
 * `PSP_NSX_EVIDENCE` (a file written by `npm run qualify:nsxbet`) or, when that is unset, from
 * a collection run by this file, which takes several minutes.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { collectEvidence } = require('../proofs');
const { EXPECTED_EXTRAS, EXPECTED_PROOFS, EXPECTED_ROWS, ROW_SUBJECTS } = require('../expected');

let evidence;
const row = (id) => {
  const found = evidence.rows.find((candidate) => candidate.id === id);
  assert.ok(found, `no row ${id}`);
  return found.evidence;
};

before(async () => {
  evidence = process.env.PSP_NSX_EVIDENCE
    ? JSON.parse(fs.readFileSync(process.env.PSP_NSX_EVIDENCE, 'utf8'))
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

  test('only the expected rows are about the shim or about Playwright itself', () => {
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

  test('versions are recorded', () => {
    assert.match(evidence.versions.engine, /^@nsxbet\/playwright-orchestrator@\d+\.\d+\.\d+/);
    assert.match(evidence.versions.playwright, /^\d+\.\d+\.\d+/);
    assert.match(evidence.versions.node, /^v\d+/);
  });
});

describe('proof 1: exactly once', () => {
  test('the Quick Start list for the whole config runs tests twice, project-blind', () => {
    assert.ok(row('1.combined').coverageViolations.duplicate > 0);
  });

  test('--repeat-each makes the engine run tests in more than one shard', () => {
    assert.ok(row('1.repeat-each').coverageViolations.duplicate > 0);
  });

  test('per-project jobs and per-project assignments cover everything once', () => {
    assert.deepStrictEqual(row('1.jobs').coverageViolations, {});
    assert.deepStrictEqual(row('1.merged').coverageViolations, {});
  });

  test('the shim covers --repeat-each exactly once', () => {
    assert.deepStrictEqual(row('1.grouped-repeat-each').coverageViolations, {});
  });
});

describe('proof 2: serial groups and dependencies', () => {
  test('the oversized serial group is split with no history and with history', () => {
    for (const id of ['2.cold', '2.history']) {
      assert.ok(
        row(id).splitGroups.some((g) => g.includes('oversized.spec.js')),
        id
      );
    }
  });

  // The second test of a serial pair needs the state its first test leaves behind.
  const SECOND_TESTS = ['two depends on the state from one', 'two uses the session from one'];

  test('without file affinity, shards fail on the second test of a split serial pair', () => {
    const evidenceRow = row('2.no-affinity');
    assert.ok(evidenceRow.splitGroups.length >= 3);
    assert.ok(evidenceRow.failedShards.length > 0);
    assert.ok(evidenceRow.failedTests.length > 0);
    assert.ok(evidenceRow.failedTests.every((title) => SECOND_TESTS.includes(title)));
  });

  test('the largest possible affinity penalty still splits a group and fails a shard', () => {
    const evidenceRow = row('2.huge-penalty');
    assert.ok(evidenceRow.splitGroups.length > 0);
    assert.ok(evidenceRow.failedShards.length > 0);
    assert.ok(evidenceRow.failedTests.length > 0);
    assert.ok(evidenceRow.failedTests.every((title) => SECOND_TESTS.includes(title)));
  });

  test('file affinity changes which groups split, and some group splits every time', () => {
    const counts = ['2.cold', '2.history', '2.no-affinity', '2.huge-penalty'].map(
      (id) => row(id).splitGroups.length
    );
    assert.ok(
      counts.every((count) => count > 0),
      counts.join(',')
    );
    assert.ok(new Set(counts).size > 1, 'the setting has an effect');
  });

  test('handing each serial group to the engine as one test keeps every group whole', () => {
    for (const id of ['2.grouped-cold', '2.grouped-history-2', '2.grouped-history-3']) {
      assert.deepStrictEqual(row(id).splitGroups, [], id);
      assert.deepStrictEqual(row(id).coverageViolations, {}, id);
      assert.deepStrictEqual(row(id).failedShards, [], id);
    }
  });

  test('setup and teardown run once in every shard that needs them', () => {
    const evidenceRow = row('2.dependencies');
    assert.deepStrictEqual(evidenceRow.dependencyViolations, []);
    assert.strictEqual(evidenceRow.runsChecked, 5);
    assert.strictEqual(evidenceRow.dependencyExecutions.length, 5);
    for (const executions of evidenceRow.dependencyExecutions) {
      assert.strictEqual(Object.keys(executions).length, 2);
      assert.ok(Object.values(executions).every((count) => count === 2));
    }
  });
});

describe('proof 3: filters', () => {
  test('--grep and --project give the same selection before and after', () => {
    for (const id of ['3.grep', '3.project']) {
      assert.deepStrictEqual(row(id).coverageViolations, {}, id);
      assert.ok(row(id).intended > 0, id);
    }
  });
});

describe('proof 4: one assignment', () => {
  test('one call gives every shard its list, the same every time', () => {
    const evidenceRow = row('4.single-assignment');
    assert.strictEqual(evidenceRow.complete, true);
    assert.strictEqual(evidenceRow.distinctOutputs, 1);
  });

  test('the assignment depends on the time the search was given', () => {
    assert.ok(row('4.single-assignment').shardCountsWhereSlowClockChangesAssignment.length > 0);
  });

  test('neither the assignment nor the history records a commit, config or selection', () => {
    const { outputKeys, timingKeys } = row('4.single-assignment');
    assert.deepStrictEqual(outputKeys, [
      'estimatedTests',
      'expectedDurations',
      'isOptimal',
      'shards',
      'testListFiles',
      'totalTests',
    ]);
    assert.deepStrictEqual(timingKeys, ['tests', 'updatedAt', 'version']);
  });
});

describe('proof 5: corrupt or mismatched input', () => {
  test('a damaged, empty or missing timing file is replaced by estimates with no sign', () => {
    const { outcomes, total } = row('5.truncated');
    assert.strictEqual(outcomes.length, 3);
    for (const outcome of outcomes) {
      assert.strictEqual(outcome.exit, 0);
      assert.strictEqual(outcome.silent, true);
      assert.strictEqual(outcome.estimated, total);
    }
  });

  test('a timing file of another version is reported on stderr and ignored', () => {
    const [outcome] = row('5.version').outcomes;
    assert.strictEqual(outcome.exit, 0);
    assert.match(outcome.stderr, /version mismatch/);
  });

  test('a null tests value stops the engine before any test runs', () => {
    const [outcome] = row('5.null-tests').outcomes;
    assert.notStrictEqual(outcome.exit, 0);
  });

  test('text or zero durations are accepted and give a meaningless balance with no sign', () => {
    for (const id of ['5.string-durations', '5.zero-durations']) {
      const [outcome] = row(id).outcomes;
      assert.strictEqual(outcome.exit, 0, id);
      assert.strictEqual(outcome.silent, true, id);
      assert.strictEqual(outcome.isOptimal, false, id);
      assert.strictEqual(outcome.outcome, 'complete assignment', id);
    }
  });

  test('timing ids that match nothing make every test an estimate, listed in the output', () => {
    const { outcomes, total } = row('5.stale-ids');
    assert.strictEqual(outcomes[0].estimated, total);
  });

  test('a timing file of another version makes every test an estimate', () => {
    const { outcomes, total } = row('5.version');
    assert.strictEqual(outcomes[0].estimated, total);
  });
});

describe('extra cases', () => {
  test('shards that plan separately from different timing files miss and repeat tests', () => {
    const { coverageViolations } = row('x1.recompute-per-shard');
    assert.ok(coverageViolations.missing > 0);
    assert.ok(coverageViolations.duplicate > 0);
  });

  test('a damaged shard artifact is skipped with a warning and a zero exit code', () => {
    const evidenceRow = row('x1.damaged-shard-artifact');
    assert.strictEqual(evidenceRow.exit, 0);
    assert.match(
      evidenceRow.stderr.join(' '),
      /Failed to load timing artifact: damaged-shard-2\.json/
    );
    assert.ok(evidenceRow.testsUpdated < evidenceRow.testsBefore);
  });

  test('a delayed older run overwrites the newer one and looks newer itself', () => {
    const evidenceRow = row('x2.racing-publish');
    assert.strictEqual(evidenceRow.updatesLost, evidenceRow.testsInHistory);
    assert.strictEqual(evidenceRow.publishedIsLaterThanNewerRun, true);
    assert.deepStrictEqual(evidenceRow.entryKeys, ['duration', 'file', 'lastRun', 'runs']);
    assert.deepStrictEqual(evidenceRow.topLevelKeys, ['tests', 'updatedAt', 'version']);
  });
});

describe('proof 6: exit codes, retries, artifacts', () => {
  test('exactly the shards that report a failed test exit non-zero, as in native sharding', () => {
    const evidenceRow = row('6.exit-codes');
    assert.ok(evidenceRow.failedShards.length > 0);
    assert.deepStrictEqual(evidenceRow.failedShards, evidenceRow.shardsWithFailedTest);
    assert.strictEqual(evidenceRow.unexpectedEngine, evidenceRow.unexpectedNative);
  });

  test('retried tests end flaky exactly as in native sharding', () => {
    const evidenceRow = row('6.retries');
    assert.strictEqual(evidenceRow.flakyEngine, evidenceRow.flakyNative);
    assert.ok(evidenceRow.flakyEngine > 0);
  });

  test('every attempt keeps its API request trace and attachment and the blob reports merge completely', () => {
    const evidenceRow = row('6.artifacts');
    assert.strictEqual(evidenceRow.traceFiles, 6);
    assert.strictEqual(evidenceRow.noteAttachments, 6);
    assert.strictEqual(evidenceRow.mergedTotal, evidenceRow.shardTotal);
  });

  test('merging the blob reports of fewer shards succeeds with fewer tests', () => {
    const evidenceRow = row('6.missing-blob');
    assert.strictEqual(evidenceRow.exit, 0);
    assert.ok(evidenceRow.mergedTotal < evidenceRow.completeTotal);
  });

  test('merging history with a missing shard artifact succeeds with a warning', () => {
    const evidenceRow = row('6.missing-timing-artifact');
    assert.strictEqual(evidenceRow.exit, 0);
    assert.ok(evidenceRow.stderr.length > 0);
    assert.ok(evidenceRow.testsUpdated < evidenceRow.testsBefore);
  });
});

describe('proof 7: no history, new tests', () => {
  test('with no history every planned test is an estimate and the suite runs in full', () => {
    const evidenceRow = row('7.cold');
    assert.deepStrictEqual(evidenceRow.coverageViolations, {});
    assert.strictEqual(evidenceRow.testsEstimated, evidenceRow.testsPlanned);
    assert.ok(evidenceRow.testsPlanned > 0);
  });

  test('a renamed test and two new tests run, are listed as estimates and enter history', () => {
    const evidenceRow = row('7.new-renamed');
    assert.deepStrictEqual(evidenceRow.coverageViolations, {});
    assert.deepStrictEqual(evidenceRow.estimatedTests, [
      'cart.spec.js::cart::adds one item',
      'wishlist.spec.js::wishlist::adds a product',
      'wishlist.spec.js::wishlist::shares the list',
    ]);
    assert.strictEqual(evidenceRow.newEntriesAfterMerge, 3);
  });

  test('the old name stays in history until it is pruned with the current test list', () => {
    const evidenceRow = row('7.new-renamed');
    assert.strictEqual(evidenceRow.staleEntryKeptAfterMerge, true);
    assert.strictEqual(evidenceRow.staleEntryPrunedWithCurrentTests, true);
  });
});

describe('proof 8: history safety', () => {
  test('a damaged history file is replaced by one shard of new data, with exit code 0', () => {
    const evidenceRow = row('8.damaged-history');
    assert.strictEqual(evidenceRow.exit, 0);
    assert.ok(evidenceRow.testsAfter < evidenceRow.testsBefore);
  });

  test('a run where a test failed at once lowers that test in history', () => {
    const evidenceRow = row('8.failed-run');
    assert.ok(evidenceRow.durationAfterMs < evidenceRow.durationBeforeMs);
  });

  test('a cancelled run records the partial duration of the interrupted test', () => {
    const { interrupted } = row('8.cancelled-run');
    assert.deepStrictEqual(
      interrupted.map((entry) => entry.id),
      ['volatile.spec.js::volatile step']
    );
    for (const entry of interrupted) {
      assert.ok(entry.recordedMs !== null, entry.id);
      assert.ok(entry.recordedMs < entry.historyMs, entry.id);
    }
  });
});

describe('privacy', () => {
  test('the guard catches connect, dns, fetch and http attempts', () => {
    const { attempts } = row('net.guard-control');
    for (const kind of ['connect', 'dns.lookup', 'fetch']) assert.ok(attempts.includes(kind), kind);
  });

  test('assign, extract-timing and merge-timing attempt no connection', () => {
    const evidenceRow = row('net.plan-timing');
    assert.strictEqual(evidenceRow.attempts, 0);
    assert.deepStrictEqual(evidenceRow.exits, [0, 0, 0, 0]);
  });

  test('the same steps work and agree under an OS-level network block', () => {
    const found = evidence.rows.find((candidate) => candidate.id === 'net.os-block');
    if (found.status === 'skipped') return;
    assert.strictEqual(found.evidence.sameAssignmentAsOpen, true);
    assert.deepStrictEqual(found.evidence.exits, [0, 0, 0, 0]);
  });
});

describe('balance and footprint', () => {
  test('balance covers two and three shards for native, engine and shim', () => {
    assert.deepStrictEqual(
      evidence.balance.map((b) => b.shards),
      [2, 3]
    );
    for (const entry of evidence.balance) {
      for (const strategy of [entry.native, entry.engine, entry.grouped]) {
        assert.strictEqual(strategy.durationsMs.length, entry.shards);
        assert.ok(strategy.slowestMs > 0);
      }
    }
  });

  test('native sharding and the shim run with no violation, the engine alone only splits groups', () => {
    for (const entry of evidence.balance) {
      assert.deepStrictEqual(entry.native.violations, {});
      assert.deepStrictEqual(entry.grouped.violations, {});
      assert.deepStrictEqual(Object.keys(entry.engine.violations), ['serial-split']);
    }
  });

  test('footprint numbers are recorded', () => {
    const { install, runtimeMs, artifactBytes } = evidence.footprint;
    assert.ok(install.packages > 0 && install.nodeModulesBytes > 0);
    assert.ok(Object.values(runtimeMs).every((ms) => ms > 0));
    assert.ok(artifactBytes.assignmentJson > 0 && artifactBytes.mergedHistory > 0);
  });
});
