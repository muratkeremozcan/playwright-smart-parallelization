'use strict';

/**
 * What the harvest decides, one entry per subject: each gap our qualifications named, each item of
 * `workflow-and-history.md`, each mechanism of the S4b brief, and each Playwright internal an
 * engine reads. An entry is `{ subject, mechanism, sources, decision, reason, evidence, s8? }`:
 *
 *   sources   the upstream lines the mechanism lives in, `{ file, lines, quote }` (with `source`
 *             `flakiness` or `playwright` for a file of an installed package); `citations.js`
 *             checks every quote at its lines
 *   decision  `take`, `adapt` or `reject`
 *   evidence  `{ rowId: status }`, the status each named row holds in the evidence; a take or an
 *             adapt names at least one row that must pass
 *   s8        the acceptance test the Action must pass, required for take and adapt
 *
 * Workflow entries add `item`, the text of `workflow-and-history.md` they answer. Internals add
 * `field`, `engine`, `readAt` (the source of the read itself), `replacement` and `loss`. The tables
 * of `docs/research/shard-balancer-harvest.md` are rendered from these lists and the evidence.
 */

const src = (file, lines, quote, source = 'upstream') => ({ source, file, lines, quote });

// Citations used by several entries.
const SHA_CHECK = src(
  'src/run.ts',
  '106-109',
  "for (const field of ['timings_sha', 'plan_sha'] as const) {"
);
const MISSING_SHARD = src('src/run.ts', '88-98', 'missing records for shard ${missingShards.join');
const MIXED = src('src/run.ts', '100-105', 'shards split the suite differently');
const CORPUS = src('src/run.ts', '110-111', 'shards saw different test sets before the split');
const NOT_RUN = src('src/run.ts', '130-131', 'stopped at max failures, or a setup project failed');
const STRICT = src(
  'src/reporter.ts',
  '171-176',
  "const strict = this.options.strict || process.env[STRICT_ENV] === '1';"
);
const FALLBACK = src(
  'src/reporter.ts',
  '195-197',
  'if (readError) return fallback(`cannot read timings: ${readError}`);'
);
const MISSING_FILE = src(
  'src/timings.ts',
  '42-47',
  '// A missing file is empty timings; anything else unreadable throws.'
);
const STRICT_ONCE = src(
  'actions/restore/action.yml',
  '63-75',
  'echo "PLAYWRIGHT_SHARD_BALANCER_STRICT=1" >> "$GITHUB_ENV"'
);
const PIN = src(
  'actions/restore/action.yml',
  '19-31',
  'key: ${{ inputs.prefix }}-pin-${{ github.run_id }}'
);
const PIN_RACE = src(
  'actions/restore/action.yml',
  '40-62',
  "# Only the first shard's save succeeds; every shard then reads the pin back, so all use one copy."
);
const SLEEP = src('actions/restore/action.yml', '53-56', 'run: sleep 20');
const EMPTY_PIN = src(
  'actions/restore/action.yml',
  '32-39',
  '# No timings yet, or a fork: write an empty file.'
);
const FORKS = src(
  'actions/restore/action.yml',
  '17-20',
  '# A pull request from a fork gets a read-only cache, so it cannot pin.'
);
const PREFIX = src(
  'actions/restore/action.yml',
  '7-9',
  'Cache key prefix. Use one per suite when a repo shards more than one.'
);
const WINDOW = src('src/timings.ts', '5-8', 'export const MAX_SAMPLES = 5;');
const ADD_SAMPLES = src(
  'src/timings.ts',
  '71-87',
  'entry.samples = entry.samples.slice(-MAX_SAMPLES);'
);
const MERGE_ORDER = src('src/timings.ts', '78-83', 'entry.samples.push(Math.round(durationMs));');
const PRUNE = src(
  'src/timings.ts',
  '71-87',
  'if (daysBetween(entry.seen, today) <= PRUNE_AFTER_DAYS)'
);
const APPLIED_CAP = src('src/timings.ts', '8', 'export const MAX_APPLIED = 200;');
const APPLIED_LOG = src(
  'src/timings.ts',
  '85',
  'const log = [...(timings.applied ?? []), ...applied].slice(-MAX_APPLIED);'
);
const MEDIAN = src('src/timings.ts', '89-93', 'export function median(values: number[]): number {');
const PASSING = src(
  'src/run.ts',
  '46-59',
  ".filter((t) => t.ran && !t.static_skip && (t.outcome === 'expected' || t.outcome === 'flaky'))"
);
const ATTEMPTS_SUMMED = src(
  'src/reporter.ts',
  '240',
  'this.durations.set(test, (this.durations.get(test) ?? 0) + result.duration);'
);
const INTERRUPTED = src(
  'src/reporter.ts',
  '263',
  "ran: test.results.length > 0 && test.results.every((r) => r.status !== 'interrupted'),"
);
const VALIDATE = src(
  'src/timings.ts',
  '18-40',
  'entry.samples.every((s) => Number.isInteger(s) && s >= 0)'
);
const ATOMIC = src('src/timings.ts', '60-67', 'renameSync(tmp, path);');
const SORTED = src(
  'src/timings.ts',
  '53-58',
  'for (const key of Object.keys(timings.tests).sort()) tests[key] = timings.tests[key];'
);
const APPLIED = src('src/commands.ts', '61-73', 'if (applied.has(digest)) {');
const FINISH_RESTORE = src(
  'actions/finish/action.yml',
  '22-28',
  "# The newest timings, not this run's pin: another run may have saved since."
);
const FINISH_UPDATE = src(
  'actions/finish/action.yml',
  '29-40',
  '$pwsb update --timings "$TIMINGS" "${records[@]}" > /dev/null'
);
const FINISH_SAVE = src(
  'actions/finish/action.yml',
  '54-59',
  '# Saved even when check fails: the durations are still good samples.'
);
const FINISH_EMPTY = src(
  'actions/finish/action.yml',
  '37-39',
  'echo "::error::no run records in $RECORDS_DIR"; exit 1; fi'
);
const CHECK = src(
  'src/run.ts',
  '80-154',
  '// Proves a sharded run ran every test exactly once: all shards present, all on the same plan,'
);
const SUMMARY = src(
  'src/commands.ts',
  '265-279',
  "'| Shard | Tests | Predicted | Test time | Whole run | Status |',"
);
const LOG_LINE = src(
  'src/reporter.ts',
  '214-222',
  'tests known, ${workers} worker(s), plan ${plan.sha}'
);
const RECORD_SHAS = src('src/reporter.ts', '206-211', 'this.record.plan_sha = plan.sha;');
const CORPUS_SHA = src(
  'src/reporter.ts',
  '188',
  'this.record.corpus = { tests: corpus.keys.length, sha: corpusSha(corpus.keys) };'
);
const RECORD_FIELDS = src('src/run.ts', '19-40', 'export type RunRecord = {');
const TIMINGS_TYPE = src(
  'src/timings.ts',
  '10-11',
  'export type Timings = { version: 1; tests: Record<string, TimingEntry>; applied?: string[] };'
);
const RECORD_WRITE = src(
  'src/reporter.ts',
  '268-272',
  "const out = resolve(base, this.options.record.replaceAll('{shard}', shard));"
);
const UPLOAD = src('examples/github-actions.yml', '28-34', 'overwrite: true');
const MATRIX = src('examples/github-actions.yml', '14-17', 'shard: [1, 2, 3, 4]');
const OPTIONS = src('src/reporter.ts', '11-25', 'export type ShardBalancerOptions = {');
const WORKERS_OPTION = src('src/reporter.ts', '19-21', 'A fixed number, not config.workers');
const WORKERS_USED = src(
  'src/reporter.ts',
  '199-200',
  'const workers = this.options.workers ?? 1;'
);
const WALL = src(
  'src/partition.ts',
  '30-43',
  '// Wall time of one shard: its items go to the first free worker, in load order.'
);
const ESTIMATE = src(
  'src/estimate.ts',
  '19-61',
  '// A known test costs the median of its samples. An unknown test costs the median of the known'
);
const SIMULATE = src('src/commands.ts', '167-202', 'elapsed_ms: p.makespan_ms + overhead,');
const SETUP_SAMPLE = src(
  'src/commands.ts',
  '99-100',
  '// One update is one run: a setup test recorded by every shard gives one sample'
);
const SETUP_COST = src('src/reporter.ts', '90-95', 'setup.set(project, cost);');
const SETUP_PLAN = src(
  'src/plan.ts',
  '37-53',
  "// A shard's setup time: each phase's projects packed onto the workers, longest first, and the"
);
const NODE_BUDGET = src(
  'src/partition.ts',
  '21-23',
  'A node count, not a clock, keeps it deterministic.'
);
const NEVER_SLOWER = src(
  'src/plan.ts',
  '171-173',
  "// Last, so it wins only when strictly faster: no plan is predicted to be slower than Playwright's own."
);
const EXCLUDE = src('src/reporter.ts', '203-204', 'testRun.skipSharding();');
const EXCLUDE_FN = src(
  'src/reporter.ts',
  '276-285',
  'if (tests.every((t) => !keep.has(t))) testRun.exclude(fileSuite);'
);
const KEY = src('src/report.ts', '33-37', "return [`[${project}]`, file, ...titles].join(' › ');");
const REPEAT = src('src/reporter.ts', '98-100', 'repeatSuffix(test.repeatEachIndex)');
const MODE_TYPES = src(
  'src/reporter.ts',
  '30-31',
  'type InternalSuite = Suite & { _parallelMode?: ParallelMode };'
);
const HOOK_CHUNKS = src(
  'src/reporter.ts',
  '45',
  'Playwright also chunks parallel tests under beforeAll/afterAll hooks; this splits them per test.'
);
const GROUP_OF = src(
  'src/reporter.ts',
  '43-59',
  "if (parent._parallelMode === 'serial' || parent._parallelMode === 'default') sequential = parent;"
);
const MODE_READ = src(
  'src/reporter.ts',
  '51-52,84',
  "insideParallel ||= parent._parallelMode === 'parallel';"
);
const EXACT = src(
  'src/reporter.ts',
  '82-84',
  "typeof (f as InternalSuite)._parallelMode === 'string'"
);
const LOCK_TYPE = src(
  'src/reporter.ts',
  '32',
  'type InternalTest = TestCase & { _locks?: string[] };'
);
const LOCK_READ = src(
  'src/reporter.ts',
  '105-107',
  'const testLocks = (test as InternalTest)._locks;'
);
const LOCK_KNOWN = src(
  'src/reporter.ts',
  '121',
  'locksKnown: locksKnown || !atLeast(config.version, 1, 63),'
);
const LOCK_MERGE = src(
  'src/atoms.ts',
  '51-85',
  '// Tests that share a Playwright lock must not run at the same time. Shards run at the same time,'
);
const FLK_MODE = src(
  'lib/playwright-test.js',
  '18140-18147',
  'function computeTestGroupSuite(testCase) {',
  'flakiness'
);
const FLK_READ = src(
  'lib/playwright-test.js',
  '18147',
  'const parallelMode = suite._parallelMode;',
  'flakiness'
);
const PW_SERIAL = src(
  'playwright/lib/common/index.js',
  '2051-2052',
  'test.annotations.unshift({ type: "serial", location: parentSuite.location });',
  'playwright'
);
const PW_SHARD = src(
  'playwright/lib/runner/index.js',
  '2462-2488',
  'function filterForShard(shard, weights, testGroups) {',
  'playwright'
);

const KEEP_LATEST = 'The aggregate job keeps only the latest attempt of each shard';

/** Gaps the Flakiness and NSXBet qualifications named. */
const GAPS = [
  {
    subject: 'Flakiness P5: shards planned from different input (`5.mismatched-timings`)',
    mechanism:
      'Every record carries the timings sha and the plan sha, `check` fails a run whose balanced shards differ in either, and the restore action pins one copy of the timings per run.',
    sources: [RECORD_SHAS, SHA_CHECK, PIN],
    decision: 'adapt',
    reason:
      'The sha comparison catches the mismatch (`s.mismatched`) after the tests ran, so we keep it in the aggregate job and add the same comparison in each shard before Playwright starts.',
    evidence: { 's.mismatched': 'pass', 'p.copies-same-plan': 'pass' },
    s8: 'Give one shard a valid timings file that differs from the snapshot: it fails before any test because its sha differs from the prepare output.',
  },
  {
    subject: 'Flakiness P5: a command line that replaces the reporters (`5.reporter-dropped`)',
    mechanism:
      'A shard without the reporter writes no record, so `check` names the missing shard, and with every reporter dropped the finish action finds no record and fails.',
    sources: [MISSING_SHARD, FINISH_EMPTY],
    decision: 'take',
    reason:
      'One record per shard turns a dropped reporter into a red run, on one shard (`s.reporter-dropped`) and on all of them (`s.reporter-dropped-all`).',
    evidence: {
      's.reporter-dropped': 'pass',
      's.reporter-dropped-all': 'pass',
      'c.missing-record': 'pass',
    },
    s8: 'Run one shard with `--reporter=list`: the aggregate job fails and names that shard. Run every shard that way: it fails on zero records.',
  },
  {
    subject:
      'Flakiness P6: `build` accepts fewer shard reports than ran (`6.missing-shard-report`)',
    mechanism:
      '`check` fails a run with a missing or repeated shard record, while the finish action runs `update` first and saves whenever `update` succeeds, and `update` takes any number of records.',
    sources: [MISSING_SHARD, FINISH_UPDATE, FINISH_SAVE],
    decision: 'adapt',
    reason:
      'The completeness rule holds (`c.missing-record`, `c.duplicate-record`), and `update` alone merges a partial run (`h.missing-shard-update`), so our aggregate job runs the check first and only a passing check reaches the history.',
    evidence: {
      'c.missing-record': 'pass',
      'c.duplicate-record': 'pass',
      'h.missing-shard-update': 'fail',
    },
    s8: 'Drop the record artifact of one shard: the aggregate job fails and the published history keeps its previous bytes.',
  },
  {
    subject:
      'Flakiness P7: the first run fails when the timings file does not exist (`7.missing-timings-file`)',
    mechanism:
      "A missing timings file loads as empty timings and every shard keeps Playwright's own split; the restore action turns strict mode on only when the pinned file has entries.",
    sources: [MISSING_FILE, FALLBACK, STRICT_ONCE],
    decision: 'adapt',
    reason:
      'An absent file gives the native split on every shard (`a.failopen-native`) and strict mode with an empty file fails every shard (`s.strict-empty`), so the prepare job picks native mode for the whole run while history is empty.',
    evidence: { 'a.failopen-native': 'pass', 's.strict-empty': 'pass' },
    s8: 'Cold start with no history: every shard runs the native split, the harness passes, and the run publishes the first history.',
  },
  {
    subject:
      'Flakiness P8: the maximum rule keeps a slow failure and ignores a faster test (`8.failed-run-slow`, `8.faster-test`)',
    mechanism:
      'A test costs the median of its last five samples from passing and flaky results; a failed or interrupted result gives no sample, and a flaky result gives the sum of all its attempts.',
    sources: [WINDOW, ADD_SAMPLES, PASSING, ATTEMPTS_SUMMED],
    decision: 'adapt',
    reason:
      'From a full window the price follows a faster test in three runs (`h.faster-test`) and a failed run adds no sample (`h.failed-slow`). A slow failed attempt before a passing retry inflates one sample, which the median of a full window absorbs (`h.flaky-slow`); our sample is the duration of the passing attempt alone.',
    evidence: {
      'h.faster-test': 'pass',
      'h.failed-slow': 'pass',
      'h.cancelled': 'pass',
      'h.flaky-slow': 'pass',
    },
    s8: 'Make a test ten times faster for three runs on a full window: its price follows. Fail it slowly once: its price stays. Fail its first attempt slowly and pass the retry: its sample is the passing attempt.',
  },
  {
    subject: 'Flakiness X2: two runs racing to publish lose updates (`x2.racing-publish`)',
    mechanism:
      'The finish action restores the newest cache entry by prefix, merges, and saves under a key of its own run; the next run restores the most recently created entry. `update` records the sha of every input it merged.',
    sources: [FINISH_RESTORE, FINISH_SAVE, APPLIED],
    decision: 'adapt',
    reason:
      'The most recently created entry wins, so a delayed older run discards the samples of a newer one (`h.racing-publish`). Our single writer lists the cache entries through the Actions cache REST API, restores the highest sequence key by its exact name, merges one complete run and saves under the next sequence number; a key that already exists means another writer won, so it reads that entry and retries. `h.remerge-union` shows the merge itself is idempotent.',
    evidence: {
      'h.racing-publish': 'fail',
      'h.remerge-union': 'pass',
      'h.duplicate-input': 'pass',
    },
    s8: 'Two writers race for the same sequence key: one save fails on the existing key, re-reads it and saves the next key, and the history holds the samples of both runs.',
  },
  {
    subject:
      'NSXBet P1: one id for a test in two projects, a repeat selected twice (`1.combined`, `1.repeat-each`)',
    mechanism:
      "A test key is `[project] › spec file › titles`, a repeat carries its index, and the reporter removes the tests of other shards with Playwright's own `testRun.exclude`.",
    sources: [KEY, REPEAT, EXCLUDE],
    decision: 'take',
    reason:
      'Keys with the project and the repeat index keep every copy apart (`a.repeat-each`, `a.balanced-3`), and exclusion inside Playwright needs no `--test-list` line.',
    evidence: { 'a.balanced-2': 'pass', 'a.balanced-3': 'pass', 'a.repeat-each': 'pass' },
    s8: 'Two browser projects under `--repeat-each 2` on three shards: every leaf runs once.',
  },
  {
    subject: 'NSXBet P2: serial groups split across shards (`2.cold`, `2.history`)',
    mechanism:
      "The reporter groups tests the way Playwright's scheduler does by reading `_parallelMode`; without that field, or with `granularity: file`, it keeps whole files.",
    sources: [GROUP_OF, EXACT, HOOK_CHUNKS, PW_SERIAL],
    decision: 'adapt',
    reason:
      "Whole files keep every serial suite whole without a read of `_parallelMode` (`a.granularity-file`, `i.psb-no-parallel-mode`). Test units from public signals alone would split `mode: 'default'` groups (`i.mode-hidden`) and the hook chunks Playwright keeps together, so our units are whole files only; on couture-cast whole files simulate within a few milliseconds of single tests up to five shards and fall behind from six (`sim.couture-cast`).",
    evidence: {
      'a.granularity-file': 'pass',
      'i.psb-no-parallel-mode': 'pass',
      'i.mode-hidden': 'pass',
      'sim.couture-cast': 'pass',
    },
    s8: 'The Action reads no private Playwright field, and every serial suite of the fixture stays on one shard under the default config and under `fullyParallel`.',
  },
  {
    subject:
      'NSXBet P6: `merge-timing` accepts a missing shard artifact (`6.missing-timing-artifact`)',
    mechanism:
      '`check` fails a run with a missing shard record; `update` itself merges any number of records.',
    sources: [MISSING_SHARD, FINISH_UPDATE],
    decision: 'adapt',
    reason:
      'The same order fix as the Flakiness gap: the completeness check (`c.missing-record`) runs before any history write, because `update` accepts a partial run (`h.missing-shard-update`).',
    evidence: { 'c.missing-record': 'pass', 'h.missing-shard-update': 'fail' },
    s8: 'Delete one shard artifact before the aggregate job: it fails and publishes nothing.',
  },
  {
    subject:
      'NSXBet P8: failed and cancelled runs and a damaged history replace good history (`8.failed-run`, `8.cancelled-run`, `8.damaged-history`)',
    mechanism:
      'Only passing and flaky results give samples, an interrupted test is marked as not run, `update` validates the history and every input before it writes, and it writes through a temporary file and a rename.',
    sources: [PASSING, INTERRUPTED, VALIDATE, ATOMIC],
    decision: 'take',
    reason:
      'Failed and cancelled runs add nothing (`h.failed-slow`, `h.cancelled`), and damaged input fails `update` with the history left byte for byte (`h.damaged-history`).',
    evidence: { 'h.failed-slow': 'pass', 'h.cancelled': 'pass', 'h.damaged-history': 'pass' },
    s8: 'Feed the history step a truncated history, a truncated record, a failed run and a cancelled run: each leaves the published bytes as they were.',
  },
  {
    subject: 'NSXBet X1: one shard plans from a damaged timing file (`x1.recompute-per-shard`)',
    mechanism:
      'With strict off the damaged shard falls back alone; with strict on it fails before any test; `check` names a mixed split afterwards.',
    sources: [STRICT, FALLBACK, MIXED],
    decision: 'adapt',
    reason:
      'Fail-open splits the shards differently (`s.failopen-damaged`) and strict mode stops the damaged shard before any test (`s.strict-damaged`), so balanced mode always runs strict and the fallback is decided once, in the prepare job.',
    evidence: { 's.failopen-damaged': 'fail', 's.strict-damaged': 'pass' },
    s8: 'Damage the snapshot of one shard: that shard fails before any test, no test runs twice, and the run is red.',
  },
  {
    subject: 'NSXBet X2: a delayed older run overwrites a newer one (`x2.racing-publish`)',
    mechanism:
      'Cache keys per run id, restored by prefix, newest created first; the window keeps the last five samples in merge order, and the `applied` list keeps the shas of the last 200 inputs.',
    sources: [FINISH_RESTORE, FINISH_SAVE, MERGE_ORDER, APPLIED_CAP, APPLIED_LOG],
    decision: 'adapt',
    reason:
      'Creation order decides and the race loses samples (`h.racing-publish`), and a run merged late would displace newer samples from a window kept in merge order. Our samples carry their run number and the window keeps the five highest run numbers, and our dedupe is by run identity, since the capped `applied` list forgets old inputs; `h.remerge-union` covers the idempotent merge.',
    evidence: { 'h.racing-publish': 'fail', 'h.remerge-union': 'pass' },
    s8: 'Merge run 101 after run 102 into a full window: the samples of run 102 stay, the sample of run 101 enters only among the five newest runs, and merging run 101 again changes no byte.',
  },
];

/** The items of `workflow-and-history.md`. */
const WORKFLOW = [
  {
    item: '**Inputs:**',
    subject:
      'Inputs: working directory, config, filters, shard count, workers, timing location, retention, switch',
    mechanism:
      'The reporter takes `timings`, `record`, `granularity`, `workers` and `strict`; the actions take the timings `path`, a cache `prefix`, the `records` folder, an optional `list` and the CLI `version`.',
    sources: [OPTIONS, PREFIX],
    decision: 'adapt',
    reason:
      "The plan workers must be a fixed input of the run: the plan never reads Playwright's `--workers` (`p.workers-independent`), and packing for the real worker count predicts better (`w.plan-workers`).",
    evidence: { 'p.workers-independent': 'pass', 'w.plan-workers': 'pass' },
    s8: 'The `workers` input reaches Playwright and the plan of every shard, and the plan sha is the same under `--workers=1` and `--workers=4`.',
  },
  {
    item: '**Prepare:**',
    subject: 'Prepare: validate inputs and lock one history snapshot for the whole run',
    mechanism:
      'The restore action pins the newest timings to the run under a cache key per run id, waits a fixed 20 seconds when the pin it raced for is not readable yet, and fails on a cache miss.',
    sources: [PIN, PIN_RACE],
    decision: 'adapt',
    reason:
      'Identical bytes give identical plans (`p.copies-same-plan`), so one snapshot is the right unit. The shards racing each other for the pin depend on a fixed sleep, so one prepare job uploads the snapshot as an artifact with its sha as a job output.',
    evidence: { 'p.copies-same-plan': 'pass', 'p.slow-clock': 'pass' },
    s8: 'Every shard verifies the snapshot sha from the prepare job before Playwright starts, and a re-run of one shard logs the same plan sha.',
  },
  {
    item: '**Execute:**',
    subject:
      'Execute: matrix over shards, uniquely named per-shard artifacts uploaded even when tests fail',
    mechanism:
      'Each shard writes its record in `onEnd`, also for a failed or stopped run, under a path with `{shard}`; the example uploads it unless the run was cancelled, with `overwrite: true` for a re-run.',
    sources: [RECORD_WRITE, UPLOAD],
    decision: 'adapt',
    reason: `A stopped shard still writes a record that names its tests that did not run (\`c.not-run\`). Our artifact names carry the run attempt, so a re-run keeps the record of the attempt that failed. ${KEEP_LATEST}, because two records of one shard fail \`check\` (\`c.duplicate-record\`).`,
    evidence: { 'c.not-run': 'pass', 'c.duplicate-record': 'pass' },
    s8: `A shard stopped by \`--max-failures\` still uploads its record, and the aggregate job names the tests that did not run. After a re-run of one shard, the aggregate job reads one record per shard, the latest attempt.`,
  },
  {
    item: '**Aggregate:**',
    subject: 'Aggregate: completeness, merge, timing update, slowest shard and imbalance summary',
    mechanism:
      '`check` proves exactly-once coverage from the records and writes predicted against measured time per shard to the job summary; `update` merges the records into the timings.',
    sources: [CHECK, SUMMARY, FINISH_UPDATE],
    decision: 'adapt',
    reason:
      'Each check holds (`c.missing-record`, `c.duplicate-record`, `c.corpus-mismatch`, `c.not-run`, `c.summary`), and the history update runs only after a passing check, because `update` alone takes a partial run (`h.missing-shard-update`).',
    evidence: {
      'c.missing-record': 'pass',
      'c.duplicate-record': 'pass',
      'c.corpus-mismatch': 'pass',
      'c.not-run': 'pass',
      'c.summary': 'pass',
      'h.missing-shard-update': 'fail',
    },
    s8: 'A complete run writes the summary table; a missing, repeated or filtered shard fails the aggregate job before any history write.',
  },
  {
    item: '**Rollback:**',
    subject:
      'Rollback: one switch disables balancing for the entire run and keeps native reporting',
    mechanism:
      "The package has no switch. An empty or absent timings file makes every shard keep Playwright's own split, which the restore action uses for forks and first runs.",
    sources: [MISSING_FILE, EMPTY_PIN],
    decision: 'adapt',
    reason:
      "With no timings every shard splits exactly as without the reporter (`a.failopen-native`), so our switch is the prepare job choosing native mode for every shard, which leaves the project's reporters as they are.",
    evidence: { 'a.failopen-native': 'pass' },
    s8: 'With the switch off, the leaves of every shard equal a run without the Action and no shard logs a plan.',
  },
  {
    item: 'Reuse `gh-build-matrix`',
    subject: 'Reuse `gh-build-matrix` for matrix generation where it fits',
    mechanism:
      'The example workflow uses a fixed matrix and `strategy.job-total`; the package generates no matrix.',
    sources: [MATRIX],
    decision: 'reject',
    reason:
      'There is nothing to harvest for matrix generation; the shard count stays an input of our prepare job.',
    evidence: {},
  },
  {
    item: 'One trusted writer.',
    subject:
      'History: one trusted writer; each record carries commit, run, config fingerprint, schema version and time',
    mechanism:
      'Records carry a kind, a schema version, the timings, plan and corpus shas and the Playwright version; the timings file carries a version, the shas of the inputs it merged and a `seen` date per entry, and no commit or run.',
    sources: [RECORD_FIELDS, CORPUS_SHA, TIMINGS_TYPE],
    decision: 'adapt',
    reason:
      'The corpus sha catches a shard that saw another selection (`c.corpus-mismatch`) and the input shas catch a replay (`h.duplicate-input`); the run number, commit and config fingerprint the policy asks for are ours to add, and one writer saves through the compare-and-swap on immutable cache keys of the X2 decision.',
    evidence: { 'c.corpus-mismatch': 'pass', 'h.duplicate-input': 'pass' },
    s8: 'The published history names the run number, commit and config fingerprint it came from, a record with another fingerprint is refused, and a second writer that loses the race for a key retries on the next one.',
  },
  {
    item: 'A delayed older run never overwrites newer history.',
    subject: 'History: a delayed older run never overwrites newer history',
    mechanism:
      'The finish action saves under a key per run id and attempt, the next run restores the most recently created entry with that prefix, and the window keeps the last five samples in merge order.',
    sources: [FINISH_RESTORE, FINISH_SAVE, MERGE_ORDER],
    decision: 'adapt',
    reason:
      'Creation order decides, so a delayed older run wins (`h.racing-publish`). Our writer restores the highest sequence key and saves the next one, and the window keeps samples by run number, so a delayed run merges in without displacing newer samples; the merge is idempotent (`h.remerge-union`).',
    evidence: { 'h.racing-publish': 'fail', 'h.remerge-union': 'pass' },
    s8: 'Publish run 101 after run 102 into a full window: every sample of run 102 stays in the history.',
  },
  {
    item: 'Observations for tests absent from a filtered run are preserved.',
    subject: 'History: observations for tests absent from a filtered run are preserved',
    mechanism:
      '`update` keeps every entry it did not sample and drops an entry no update has seen for 30 days.',
    sources: [PRUNE],
    decision: 'adapt',
    reason:
      'A filtered run keeps the other entries (`h.filtered-run`), and the 30-day expiry drops a test a filter left out for a month (`h.expiry`), so only runs of the full selection update our history and the expiry only removes deleted tests.',
    evidence: { 'h.filtered-run': 'pass', 'h.expiry': 'pass' },
    s8: 'A filtered run publishes nothing, and a test deleted from the suite leaves the history after 30 days.',
  },
  {
    item: 'Failed, cancelled, or incomplete runs',
    subject:
      'History: failed, cancelled or incomplete runs and zero-valued data never replace good history',
    mechanism:
      'Only passing and flaky results give samples, an interrupted test is not run, input is validated; any number of records is accepted, and a sample of zero is valid.',
    sources: [PASSING, INTERRUPTED, VALIDATE],
    decision: 'adapt',
    reason:
      'Failed and cancelled results add nothing (`h.failed-slow`, `h.cancelled`) and damaged input is refused (`h.damaged-history`); an incomplete run still merges (`h.missing-shard-update`), so completeness gates our update.',
    evidence: {
      'h.failed-slow': 'pass',
      'h.cancelled': 'pass',
      'h.damaged-history': 'pass',
      'h.missing-shard-update': 'fail',
    },
    s8: 'A failed, a cancelled and an incomplete run each leave the published history byte for byte.',
  },
  {
    item: 'Bounded observation window',
    subject: 'History: a bounded observation window that adapts after tests get faster',
    mechanism:
      'The last five samples per test, priced at their median, and entries unseen for 30 days dropped.',
    sources: [WINDOW, ADD_SAMPLES, MEDIAN],
    decision: 'take',
    reason:
      'From a full window the price of a faster test drops in three runs (`h.faster-test`) and stale entries expire (`h.expiry`).',
    evidence: { 'h.faster-test': 'pass', 'h.expiry': 'pass' },
    s8: "Three faster runs on a full window bring a test's price to its new duration.",
  },
  {
    item: 'Separate history per browser',
    subject: 'History: separate per browser, runner class and worker count',
    mechanism:
      'Keys carry the project name; the actions take a cache `prefix` per suite; the plan packs for the `workers` option.',
    sources: [KEY, PREFIX, WORKERS_OPTION],
    decision: 'adapt',
    reason:
      'Per-project keys keep chromium and firefox apart in one file (`h.filtered-run` holds a separate entry per project); the runner class and the worker count go into our cache key, since the plan changes with the workers it packs for (`w.plan-workers`).',
    evidence: { 'h.filtered-run': 'pass', 'w.plan-workers': 'pass' },
    s8: 'Changing the runner label or the workers input starts a separate history.',
  },
  {
    item: 'Reuse the engine',
    subject:
      'History: reuse the engine format and merger first; change policy only when measurements show a problem',
    mechanism:
      "A five-sample median window over passing and flaky samples, in the package's own timings format.",
    sources: [WINDOW, MEDIAN],
    decision: 'adapt',
    reason:
      'Our Flakiness qualification measured the problem of its maximum merger (`8.failed-run-slow`, `8.faster-test` there), which justifies the change, and the median window is the measured replacement (`h.faster-test`, `h.failed-slow`, `h.flaky-slow`).',
    evidence: { 'h.faster-test': 'pass', 'h.failed-slow': 'pass', 'h.flaky-slow': 'pass' },
    s8: 'The history the Action writes passes the same faster-test, slow-failure and slow-retry acceptance tests as the window.',
  },
  {
    item: 'Persist in the consuming repo',
    subject: "History: persist in the consuming repo's own Actions storage",
    mechanism:
      "Timings live in the repository's Actions cache and records in its artifacts; the reporter and the commands make no network call.",
    sources: [PIN, UPLOAD],
    decision: 'take',
    reason: 'No connection attempt in a guarded run and in the commands (`n.no-network`).',
    evidence: { 'n.no-network': 'pass' },
    s8: "The Action's fixture run under the network guard records zero connection attempts.",
  },
  {
    item: 'Documentation of cold start',
    subject:
      'Deliverables: cold start, refresh, diagnostics (imbalance summary) and rollback documentation',
    mechanism:
      'One log line per shard with the timings and plan shas and the known test count, and a job summary of predicted against measured time.',
    sources: [LOG_LINE, SUMMARY],
    decision: 'take',
    reason:
      'Both work on the fixture (`a.log-line`, `c.summary`) and are what the diagnostics section documents.',
    evidence: { 'a.log-line': 'pass', 'c.summary': 'pass' },
    s8: 'Every shard logs one plan line with the same plan sha, and the job summary has one row per shard.',
  },
];

/** The mechanisms the S4b brief names, and the others the package rests on. */
const MECHANISMS = [
  {
    subject: 'Fail-open, with strict mode once timings exist',
    mechanism:
      'A shard that cannot use the timings falls back to the built-in split unless strict mode is on; the restore action turns strict on when the pinned file has entries.',
    sources: [STRICT, FALLBACK, STRICT_ONCE],
    decision: 'adapt',
    reason:
      'Fail-open per shard splits shards differently (`s.failopen-damaged`); strict mode stops the shard (`s.strict-damaged`) and cannot run on empty history (`s.strict-empty`). We decide native or balanced for the whole run in prepare and run balanced mode strict.',
    evidence: {
      'a.failopen-native': 'pass',
      's.strict-damaged': 'pass',
      's.strict-empty': 'pass',
      's.failopen-damaged': 'fail',
    },
    s8: 'With history present, a shard that cannot read the snapshot fails before any test.',
  },
  {
    subject: 'One timings copy pinned per workflow run',
    mechanism:
      'A cache entry keyed by the run id, saved by the first shard and read back by the others and by re-runs.',
    sources: [PIN, PIN_RACE],
    decision: 'adapt',
    reason:
      'One snapshot gives one plan (`p.copies-same-plan`); our snapshot comes from one prepare job before the matrix, as an artifact with its sha.',
    evidence: { 'p.copies-same-plan': 'pass' },
    s8: 'Shards and re-runs of a run log one plan sha.',
  },
  {
    subject: 'The `sleep 20` wait of the cache pin',
    mechanism:
      'When the pin a shard raced for is not readable yet, it sleeps 20 seconds and restores again with `fail-on-cache-miss`.',
    sources: [SLEEP, PIN_RACE],
    decision: 'reject',
    reason:
      'A fixed wait bets that the winning upload finishes in 20 seconds; a prepare job that uploads one artifact before the matrix starts has nothing to wait for.',
    evidence: {},
  },
  {
    subject: 'Median of the last 5 passing samples',
    mechanism:
      'Samples of passing and flaky results only, all attempts summed, the last five kept, priced at their median.',
    sources: [WINDOW, ADD_SAMPLES, MEDIAN, PASSING, ATTEMPTS_SUMMED],
    decision: 'adapt',
    reason:
      'It adapts to a faster test (`h.faster-test`) and ignores failed and cancelled runs (`h.failed-slow`, `h.cancelled`). A flaky result sums its slow failed attempt into its sample, which a full window absorbs (`h.flaky-slow`); our sample is the passing attempt.',
    evidence: {
      'h.faster-test': 'pass',
      'h.failed-slow': 'pass',
      'h.cancelled': 'pass',
      'h.flaky-slow': 'pass',
    },
    s8: 'The faster-test, slow-failure, cancelled-run and slow-retry cases of the fixture, with the passing attempt as the sample of a flaky test.',
  },
  {
    subject: 'New-test estimate from describe, then file, then project, then suite',
    mechanism:
      'An unknown test costs the median of the known tests of its describe, else its file, else its project, else the whole timings file; a static skip costs nothing.',
    sources: [ESTIMATE],
    decision: 'take',
    reason:
      'On a suite where the four medians differ, our own medians reproduce the package at every level (`e.hierarchy`), and renamed and new tests run and are counted unknown (`a.renamed`).',
    evidence: { 'e.hierarchy': 'pass', 'a.renamed': 'pass' },
    s8: "A new test in a known describe is priced at that describe's median and the run covers it once.",
  },
  {
    subject: 'The `check` exactly-once proof',
    mechanism:
      'All shards present once, one strategy, one timings and plan sha, one corpus, no test twice, none missing, none stopped.',
    sources: [CHECK, MISSING_SHARD, MIXED, SHA_CHECK, CORPUS, NOT_RUN],
    decision: 'adapt',
    reason:
      'Every check fires on the fixture (`c.missing-record`, `c.duplicate-record`, `c.not-run`, `c.corpus-mismatch`, `s.mismatched`); ours runs before the history update.',
    evidence: {
      'c.missing-record': 'pass',
      'c.duplicate-record': 'pass',
      'c.not-run': 'pass',
      'c.corpus-mismatch': 'pass',
      's.mismatched': 'pass',
    },
    s8: 'Each failure of the check cases fails the aggregate job and publishes nothing.',
  },
  {
    subject: '`simulate` for shard-count advice',
    mechanism:
      'Replays a JSON list against the timings for a range of shard counts, with the built-in split, balanced, the lower bound and a per-shard overhead.',
    sources: [SIMULATE],
    decision: 'adapt',
    reason:
      "The model predicts the fixture (`sim.predicted-vs-actual`) and couture-cast's measured split (`sim.couture-cast`), and the overhead input is exact (`sim.overhead`); we feed it the per-shard overhead measured in S5, so the advice counts machine time.",
    evidence: {
      'sim.predicted-vs-actual': 'pass',
      'sim.overhead': 'pass',
      'sim.couture-cast': 'pass',
    },
    s8: "The Action's summary prints the simulated elapsed and machine time for the next two shard counts from the run's own overhead.",
  },
  {
    subject: 'Workers-per-shard planning',
    mechanism: "The plan packs each shard onto a fixed `workers` count in Playwright's load order.",
    sources: [WORKERS_OPTION, WORKERS_USED, WALL],
    decision: 'take',
    reason:
      "Packing for two workers predicts a two-worker shard better (`w.plan-workers`), and the plan ignores Playwright's own `--workers` (`p.workers-independent`).",
    evidence: { 'w.plan-workers': 'pass', 'p.workers-independent': 'pass' },
    s8: 'Under `--workers=2` the predicted shard times of the summary are within the tolerance of the measured ones.',
  },
  {
    subject: 'Lock groups on one shard',
    mechanism:
      'Tests that share a lock are merged into one unit, from the internal `_locks` of each test.',
    sources: [LOCK_READ, LOCK_MERGE],
    decision: 'reject',
    reason:
      "A lock has no public signal (`i.lock-hidden`), and Playwright's own sharding splits lock groups too (`i.lock-native-split`), so leaving it out keeps native semantics.",
    evidence: { 'i.lock-hidden': 'pass', 'i.lock-native-split': 'pass', 'i.psb-locks': 'pass' },
  },
  {
    subject: 'Setup projects priced on every shard that needs them, one sample per update',
    mechanism:
      'A setup or teardown project adds its cost to each shard that hosts a dependent test, packed by phase, and an update takes one sample of it however many shards ran it.',
    sources: [SETUP_COST, SETUP_PLAN, SETUP_SAMPLE],
    decision: 'take',
    reason:
      'On a config where one project needs setup, the predicted time of each shard is its work plus the setup cost exactly where it hosts that project (`a.setup-aware`), and the setup project ran on both shards and has one sample (`h.setup-once`).',
    evidence: { 'a.setup-aware': 'pass', 'h.setup-once': 'pass' },
    s8: 'A setup project run by every shard gains one sample per published run, and a shard that hosts no dependent test runs no setup.',
  },
  {
    subject:
      'A deterministic search with a node budget, never predicted slower than the built-in split',
    mechanism:
      "Branch and bound stops at a node count, and Playwright's own split is scored last so a plan wins only when strictly faster.",
    sources: [NODE_BUDGET, NEVER_SLOWER],
    decision: 'take',
    reason:
      'Every simulated shard count predicts the balanced plan at or below the built-in split, on the fixture and on couture-cast (`sim.predicted-vs-actual`, `sim.couture-cast`); measured, the two-shard balanced run, which the model predicts level with the built-in split, finished a little slower than two native runs that agree with each other (`a.balanced-2`), so the rule bounds the prediction and an already even native split can still win a run. The node budget rests on the cited source; `p.slow-clock` checks determinism only.',
    evidence: {
      'sim.predicted-vs-actual': 'pass',
      'sim.couture-cast': 'pass',
      'a.balanced-2': 'pass',
      'p.slow-clock': 'pass',
    },
    s8: 'The plan sha is the same on a slow runner and a fast one, and no simulated shard count predicts the balanced plan above the built-in split.',
  },
  {
    subject: 'Input dedupe by sha',
    mechanism:
      '`update` records the sha of every input and skips one it already merged, keeping the last 200 shas.',
    sources: [APPLIED, APPLIED_CAP],
    decision: 'adapt',
    reason:
      'A replayed record changes no byte (`h.duplicate-input`, `h.remerge-union`); the list forgets inputs past its cap, so our writer dedupes by run identity.',
    evidence: { 'h.duplicate-input': 'pass', 'h.remerge-union': 'pass' },
    s8: 'Re-running the publish job for any earlier run leaves the history byte for byte.',
  },
  {
    subject: 'Validation and atomic save of the history',
    mechanism:
      'The file is parsed and every entry checked before anything is written, and the write goes through a temporary file and a rename.',
    sources: [VALIDATE, ATOMIC],
    decision: 'take',
    reason:
      'Damaged history and damaged input are refused with the file unchanged (`h.damaged-history`).',
    evidence: { 'h.damaged-history': 'pass' },
    s8: 'A truncated history restored from the cache fails the publish job and is not saved.',
  },
  {
    subject: 'Deterministic bytes with sorted keys',
    mechanism:
      'Entries are written with sorted keys, so the same history is the same bytes and the same sha.',
    sources: [SORTED],
    decision: 'adapt',
    reason:
      'The same inputs in one order give one sha (`h.deterministic-bytes`); the `applied` list follows the input order, so our writer sorts its inputs by run and shard.',
    evidence: { 'h.deterministic-bytes': 'pass' },
    s8: 'Publishing the same records in any order gives the same sha.',
  },
  {
    subject: 'Exclusion through `testRun.exclude` and `testRun.skipSharding`',
    mechanism:
      "Inside `Reporter.preprocess` the reporter excludes the tests of other shards and turns Playwright's own split off.",
    sources: [EXCLUDE, EXCLUDE_FN],
    decision: 'take',
    reason:
      'It is the public API our CAP-7 path names; balanced runs cover every leaf once (`a.balanced-3`) and without timings nothing is excluded (`a.failopen-native`).',
    evidence: { 'a.balanced-3': 'pass', 'a.failopen-native': 'pass' },
    s8: 'A balanced fixture run excludes through the public preprocess API only.',
  },
  {
    subject: 'Fork pull requests use the built-in split',
    mechanism:
      'The restore action treats the cache of a fork pull request as read-only (its comment, since upstream commit `8ed9ea3`), skips the pin and writes empty timings, so every shard of a fork run uses the built-in split.',
    sources: [FORKS, EMPTY_PIN],
    decision: 'reject',
    reason:
      "GitHub documents that a `pull_request` run from a fork can restore the caches of the base branch and saves only under the pull request's own ref, so a fork can balance from the base history; our prepare job snapshots it like any run and only the trusted publish job writes.",
    evidence: {},
    s8: 'On a real fork pull request the prepare job restores the base branch history, the shards balance from it, and nothing reaches the history of the base branch.',
  },
];

/** The Playwright internals the engines read. */
const INTERNALS = [
  {
    subject: '`_parallelMode` in playwright-shard-balancer',
    engine: 'playwright-shard-balancer',
    field: 'Suite._parallelMode',
    readAt: MODE_READ,
    mechanism:
      "Groups tests the way Playwright's scheduler does: a file outside parallel mode is one unit, and in parallel mode each test is, except inside a serial or default-mode describe.",
    sources: [MODE_TYPES, GROUP_OF, MODE_READ, EXACT],
    decision: 'reject',
    reason:
      'A release without the field turns the reporter to whole files, still balanced and exactly once (`i.psb-no-parallel-mode`).',
    replacement:
      'The public `serial` annotation of each test inside a serial describe (`i.serial-public`), and `FullConfig.fullyParallel` for the suite-wide mode.',
    loss: "`mode: 'parallel'` and `mode: 'default'` have no public signal (`i.mode-hidden`), so whole files are the only safe unit.",
    evidence: {
      'i.psb-no-parallel-mode': 'pass',
      'i.serial-public': 'pass',
      'i.mode-hidden': 'pass',
    },
  },
  {
    subject: '`_locks` in playwright-shard-balancer',
    engine: 'playwright-shard-balancer',
    field: 'TestCase._locks',
    readAt: LOCK_READ,
    mechanism:
      'Merges the units of tests that share a lock into one unit, so they go to one shard.',
    sources: [LOCK_TYPE, LOCK_READ, LOCK_KNOWN, LOCK_MERGE, PW_SHARD],
    decision: 'reject',
    reason:
      'A release without the field leaves lock groups to split, with a log line that says so (`i.psb-no-locks`).',
    replacement: 'None: a lock has no public signal (`i.lock-hidden`).',
    loss: "Tests that share a lock may run on two shards at once, which Playwright's own sharding also does (`i.lock-native-split`).",
    evidence: { 'i.psb-no-locks': 'pass', 'i.lock-hidden': 'pass', 'i.lock-native-split': 'pass' },
  },
  {
    subject: '`_parallelMode` in @flakiness/playwright',
    engine: '@flakiness/playwright',
    field: 'Suite._parallelMode',
    readAt: FLK_READ,
    mechanism:
      '`computeTestGroupSuite` takes the outermost serial or default-mode suite as the unit inside parallel mode, and the file otherwise.',
    sources: [FLK_MODE, FLK_READ],
    decision: 'reject',
    reason:
      'A release without the field turns the reporter to whole files, still balanced and exactly once, with no warning (`i.flakiness-no-parallel-mode`); S7 records the dependency.',
    replacement:
      'The same as for playwright-shard-balancer: the `serial` annotation and `FullConfig.fullyParallel`.',
    loss: 'The same as for playwright-shard-balancer, and the Flakiness reporter gives no sign of it.',
    evidence: { 'i.flakiness-internal': 'pass', 'i.flakiness-no-parallel-mode': 'pass' },
  },
];

const LISTS = { gaps: GAPS, workflow: WORKFLOW, mechanisms: MECHANISMS, internals: INTERNALS };

/** Every entry of every list. */
const ALL = [...GAPS, ...WORKFLOW, ...MECHANISMS, ...INTERNALS];

module.exports = { ALL, GAPS, INTERNALS, KEEP_LATEST, LISTS, MECHANISMS, WORKFLOW };
