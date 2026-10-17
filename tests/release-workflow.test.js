'use strict';

/**
 * Tests for the Release workflow. It writes tags and releases with the repository token, so it
 * keeps its guards: least privilege per job, write jobs that run no repository code, every gate and
 * the Action smoke before a draft and again before the floating major tag moves, the immutable and
 * Marketplace checks, and the tag handling that never moves an exact tag or rolls a major back.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const TEXT = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const WORKFLOW = YAML.parse(TEXT);
const { jobs } = WORKFLOW;
const ACTION = YAML.parse(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));
const DRAFT_JOB = TEXT.slice(TEXT.indexOf('  draft:'), TEXT.indexOf('  verify:'));

const stepNames = (job) => jobs[job].steps.map((s) => s.name);
const stepIndex = (job, name) => {
  const index = stepNames(job).indexOf(name);
  assert.ok(index > -1, `${job} has the step ${name}`);
  return index;
};

describe('triggers and permissions', () => {
  test('prepares from a bump choice and promotes only published releases', () => {
    const bump = WORKFLOW.on.workflow_dispatch.inputs.bump;
    assert.strictEqual(bump.type, 'choice');
    assert.deepStrictEqual(bump.options, ['patch', 'minor', 'major']);
    assert.deepStrictEqual(WORKFLOW.on.release.types, ['published']);
    assert.deepStrictEqual(Object.keys(WORKFLOW.on).sort(), ['release', 'workflow_dispatch']);
  });

  test('never cancels a release run, running or pending', () => {
    assert.strictEqual(
      WORKFLOW.concurrency.group,
      'playwright-smart-parallelization-release-${{ github.event.release.tag_name || github.event_name }}',
      'a publication has a group of its own, so no later run cancels it while it is pending'
    );
    assert.strictEqual(WORKFLOW.concurrency['cancel-in-progress'], false);
  });

  test('grants nothing by default and each job only the contents access it needs', () => {
    assert.deepStrictEqual(WORKFLOW.permissions, {});
    assert.deepStrictEqual(Object.keys(jobs), ['prepare', 'draft', 'verify', 'promote']);
    assert.deepStrictEqual(jobs.prepare.permissions, { contents: 'read' });
    assert.deepStrictEqual(jobs.draft.permissions, { contents: 'write' });
    assert.deepStrictEqual(jobs.verify.permissions, { contents: 'read' });
    assert.deepStrictEqual(jobs.promote.permissions, { contents: 'write' });
  });

  test('the jobs that write run no repository code', () => {
    for (const name of ['draft', 'promote']) {
      for (const step of jobs[name].steps) {
        assert.strictEqual(step.uses, undefined, `${name}: ${step.name}`);
        assert.doesNotMatch(step.run, /\bnode\b|\bnpm\b|scripts\//, `${name}: ${step.name}`);
      }
    }
  });

  test('the dispatch jobs and the publication jobs never run on the other event', () => {
    for (const name of ['prepare', 'draft']) {
      assert.strictEqual(jobs[name].if, "github.event_name == 'workflow_dispatch'");
    }
    const published = "github.event_name == 'release' && github.event.action == 'published'";
    assert.strictEqual(jobs.verify.if, published);
    assert.ok(
      jobs.promote.if.startsWith(`${published} && `),
      'promote also needs a current release'
    );
    assert.strictEqual(jobs.draft.needs, 'prepare');
    assert.strictEqual(jobs.promote.needs, 'verify');
  });

  test('pins every external action to a full commit SHA', () => {
    const external = Object.values(jobs)
      .flatMap((job) => job.steps)
      .map((s) => s.uses)
      .filter((uses) => uses && uses !== './');
    assert.ok(external.length > 0);
    for (const uses of external) assert.match(uses, /@[0-9a-f]{40}$/);
  });

  test('checks out without persisting the token', () => {
    for (const name of ['prepare', 'verify']) {
      const checkout = jobs[name].steps.find((s) => /actions\/checkout@/.test(s.uses ?? ''));
      assert.strictEqual(checkout.with['persist-credentials'], false);
      assert.strictEqual(checkout.with['fetch-depth'], 0);
    }
    assert.strictEqual(
      jobs.verify.steps[0].with.ref,
      '${{ github.event.release.tag_name }}',
      'verify tests the published tag'
    );
  });
});

describe('gates', () => {
  test('prepare requires main before it installs or runs anything', () => {
    const guard = stepIndex('prepare', 'Require the default branch');
    assert.ok(guard < stepIndex('prepare', 'Install dependencies'));
    assert.match(jobs.prepare.steps[guard].run, /"\$GITHUB_REF" != 'refs\/heads\/main'/);
  });

  test('verify validates the release before it installs or runs repository code', () => {
    assert.ok(
      stepIndex('verify', 'Validate the immutable release') <
        stepIndex('verify', 'Install dependencies')
    );
  });

  for (const name of ['prepare', 'verify']) {
    test(`${name} runs validate, the main step of the Action and a native run with PSP_ARGS`, () => {
      const steps = jobs[name].steps;
      const validate = stepIndex(name, 'Run the validate gates');
      const smoke = stepIndex(name, 'Run the deterministic Action smoke');
      const playwright = stepIndex(name, 'Run Playwright with PSP_ARGS');
      const outputs = stepIndex(name, 'Require the smoke outputs');
      assert.strictEqual(steps[validate].run, 'npm run validate');
      assert.ok(stepIndex(name, 'Install dependencies') < validate);
      assert.ok(validate < smoke && smoke < playwright && playwright < outputs);

      const step = steps[smoke];
      assert.strictEqual(step.uses, './');
      assert.strictEqual(step.with['publish-history'], 'false', 'the smoke writes no history');
      assert.strictEqual(step.with['working-directory'], 'fixtures/consumer');
      assert.match(step.with['history-key'], /github\.run_id.*github\.run_attempt/);
      assert.strictEqual(step.with.enabled, undefined, 'the smoke plans for real');
      assert.strictEqual(step.with.phase, undefined);

      assert.strictEqual(steps[playwright]['working-directory'], 'fixtures/consumer');
      assert.match(steps[playwright].run, /--shard=1\/2 \$PSP_ARGS$/);

      const check = steps[outputs];
      assert.match(check.env.MODE, new RegExp(`steps\\.${step.id}\\.outputs\\.mode`));
      assert.match(check.run, /test "\$MODE" = native/);
      assert.match(check.run, /test "\$REASON" = 'no history yet'/);
      assert.match(check.run, /\$PSP_RECORD/);
    });
  }

  test('prepare derives the version only after the gates and the smoke pass', () => {
    assert.ok(
      stepIndex('prepare', 'Require the smoke outputs') <
        stepIndex('prepare', 'Derive the next exact version')
    );
    assert.strictEqual(jobs.prepare.outputs['release-sha'], '${{ github.sha }}');
  });

  test('verify gates the tag shape, main ancestry, immutability, action.yml and ordering', () => {
    const run = jobs.verify.steps[stepIndex('verify', 'Validate the immutable release')].run;
    assert.match(run, /\^v\(0\|\[1-9\]\[0-9\]\*\)/);
    assert.match(run, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
    assert.match(run, /--jq \.immutable\)/);
    assert.match(run, /if \[ "\$immutable" != 'true' \]/);
    assert.match(run, /contents\/action\.yml\?ref=\$TAG/);
    assert.match(run, /release-version\.js compare "\$TAG" "\$highest_tag"/);
    assert.match(run, /if \[ "\$release_order" -lt 0 \]/);
  });
});

describe('Marketplace and the floating major tag', () => {
  test('checks the Marketplace page of this action for the exact tag before moving the major', () => {
    const step = jobs.verify.steps[stepIndex('verify', 'Verify Marketplace publication')];
    const slug = ACTION.name.toLowerCase().replace(/\s+/g, '-');
    assert.match(step.run, new RegExp(`https://github\\.com/marketplace/actions/${slug}'`));
    assert.match(step.run, /grep --fixed-strings --word-regexp --quiet "\$TAG"/);
    assert.deepStrictEqual(stepNames('verify').slice(-2), [
      'Verify Marketplace publication',
      'Recheck the release order',
    ]);
  });

  test('verifies the exact and the floating tag resolve to the release commit', () => {
    const check = jobs.promote.steps[1];
    assert.strictEqual(check.name, 'Verify exact and floating references');
    assert.match(check.run, /test "\$exact_sha" = "\$RELEASE_SHA"/);
    assert.match(check.run, /test "\$major_sha" = "\$RELEASE_SHA"/);
    assert.match(check.run, /contents\/action\.yml\?ref=\$MAJOR/);
    assert.doesNotMatch(TEXT, /gh release create "\$MAJOR"/);
  });
});

describe('the draft', () => {
  test('keeps the existing-tag guard and creates a missing exact tag before a new draft', () => {
    const tagLookup = DRAFT_JOB.indexOf(
      'if ref=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG"'
    );
    const mismatchGuard = DRAFT_JOB.indexOf(
      'Tag $TAG already points to $existing_sha instead of $RELEASE_SHA.'
    );
    const tagCreation = DRAFT_JOB.indexOf('-f ref="refs/tags/$TAG"');
    const releaseCreation = DRAFT_JOB.indexOf('gh release create "$TAG"');
    const newDraftTagGuard = DRAFT_JOB.lastIndexOf(
      'if [ "$tag_preexisted" = \'false\' ]; then',
      releaseCreation
    );
    const newDraftPreparation = DRAFT_JOB.slice(newDraftTagGuard, releaseCreation);

    assert.ok(tagLookup > -1 && tagLookup < releaseCreation);
    assert.ok(mismatchGuard > tagLookup && mismatchGuard < releaseCreation);
    assert.ok(tagCreation > mismatchGuard && tagCreation < releaseCreation);
    assert.ok(newDraftTagGuard > tagCreation);
    assert.match(newDraftPreparation, /create_exact_tag/);
    assert.match(DRAFT_JOB, /--draft/);
    assert.match(DRAFT_JOB, /--generate-notes/);
    assert.match(DRAFT_JOB, /--target "\$RELEASE_SHA"/);
    assert.doesNotMatch(DRAFT_JOB, /--verify-tag/);
  });

  test('retargets an automated stale draft before repairing its missing exact tag', () => {
    const existingDraftStart = DRAFT_JOB.indexOf('if release=$(gh release view "$TAG"');
    const existingDraftEnd = DRAFT_JOB.indexOf('# Let the Releases API');
    const existingDraft = DRAFT_JOB.slice(existingDraftStart, existingDraftEnd);
    const retarget = existingDraft.indexOf('gh release edit "$TAG"');
    const tagRepair = existingDraft.indexOf('create_exact_tag');

    assert.match(existingDraft, /--json author,isDraft,tagName,targetCommitish,url/);
    assert.match(existingDraft, /validate_draft "\$release"/);
    assert.match(existingDraft, /if \[ "\$release_target" != "\$RELEASE_SHA" \]/);
    assert.match(existingDraft, /if \[ "\$release_author" != 'github-actions\[bot\]' \]/);
    assert.match(existingDraft, /releases\/generate-notes/);
    assert.ok(retarget > -1 && retarget < tagRepair);
    assert.match(existingDraft, /verify_exact_tag/);
  });

  test("verifies the created draft's own tag and accepts its synthetic URL", () => {
    const releaseCreation = DRAFT_JOB.indexOf('gh release create "$TAG"');
    const releaseVerification = DRAFT_JOB.indexOf('created_release=$(gh release view "$TAG"');
    const successSummary = DRAFT_JOB.lastIndexOf('publish_steps "$url"');
    const verificationBlock = DRAFT_JOB.slice(releaseVerification, successSummary);

    assert.ok(releaseCreation > -1 && releaseCreation < releaseVerification);
    assert.ok(releaseVerification < successSummary);
    assert.match(verificationBlock, /--json author,isDraft,tagName,targetCommitish,url/);
    assert.match(verificationBlock, /validate_draft "\$created_release"/);
    assert.match(verificationBlock, /if \[ "\$created_url" != "\$url" \]/);
    assert.doesNotMatch(DRAFT_JOB, /expected_url|releases\/tag\/\$TAG/);
  });

  test('tells the maintainer what to click to publish to the Marketplace', () => {
    assert.match(DRAFT_JOB, /Tick Publish this Action to the GitHub Marketplace/);
    assert.match(DRAFT_JOB, /Click Publish release/);
    assert.match(DRAFT_JOB, />> "\$GITHUB_STEP_SUMMARY"/);
  });
});

/**
 * A fake `gh` on PATH for the shell of a workflow step: `gh api` over a JSON state of releases,
 * refs and annotated tag objects, with `--jq` applied by the real jq. Every call is logged, so a
 * test can tell whether the step changed a ref.
 */
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
const fail = (message) => {
  process.stderr.write('gh: ' + message + '\\n');
  process.exit(1);
};
if (args[0] !== 'api') fail('unexpected command ' + args.join(' '));
let method = 'GET';
let jq = null;
let endpoint = null;
let paginate = false;
const fields = {};
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--method') method = args[++i];
  else if (arg === '--jq') jq = args[++i];
  else if (arg === '--paginate') paginate = true;
  else if (arg === '-f' || arg === '-F') {
    const [name, ...value] = args[++i].split('=');
    fields[name] = value.join('=');
  } else endpoint = arg;
}
const repo = 'repos/' + process.env.GITHUB_REPOSITORY + '/';
if (!endpoint || !endpoint.startsWith(repo)) fail('unexpected endpoint ' + endpoint);
const route = endpoint.slice(repo.length);
const print = (body) => {
  if (jq === null) return process.stdout.write(JSON.stringify(body) + '\\n');
  const out = spawnSync('jq', ['-r', jq], { input: JSON.stringify(body), encoding: 'utf8' });
  if (out.status !== 0) fail('jq failed: ' + out.stderr);
  process.stdout.write(out.stdout);
};
let body;
let match;
if (method === 'GET' && route === 'releases?per_page=100') {
  if (state.releasesDown) fail('Server Error (HTTP 502)');
  // Like gh, --paginate applies --jq to every page; without it only the first page arrives.
  const size = state.pageSize || 100;
  const pages = [];
  for (let i = 0; i < state.releases.length; i += size) pages.push(state.releases.slice(i, i + size));
  for (const page of paginate ? pages : pages.slice(0, 1)) print(page);
  process.exit(0);
} else if (method === 'GET' && (match = /^git\\/ref\\/tags\\/(.+)$/.exec(route))) {
  const ref = state.refs[match[1]];
  if (!ref) fail('Not Found (HTTP 404)');
  body = { ref: 'refs/tags/' + match[1], object: ref };
} else if (method === 'GET' && (match = /^git\\/tags\\/([0-9a-f]+)$/.exec(route))) {
  const tag = state.tags[match[1]];
  if (!tag) fail('Not Found (HTTP 404)');
  body = { sha: match[1], object: tag };
} else if (method === 'PATCH' && (match = /^git\\/refs\\/tags\\/(.+)$/.exec(route))) {
  if (!state.refs[match[1]]) fail('Reference does not exist (HTTP 422)');
  state.refs[match[1]] = { type: 'commit', sha: fields.sha };
  save();
  body = {};
} else if (method === 'POST' && route === 'git/refs') {
  const name = fields.ref.replace(/^refs\\/tags\\//, '');
  if (state.refs[name]) fail('Reference already exists (HTTP 422)');
  state.refs[name] = { type: 'commit', sha: fields.sha };
  save();
  body = {};
} else fail('unexpected call ' + method + ' ' + route);
print(body);
`;

const SHA = {
  v100: 'a'.repeat(40),
  v101: 'b'.repeat(40),
  v200: 'c'.repeat(40),
  other: 'd'.repeat(40),
};
const ANNOTATED = 'e'.repeat(40);

const published = (...tags) =>
  tags.map((tag) => ({ tag_name: tag, draft: false, prerelease: false }));

/**
 * Runs the shell of `step` the way the runner does, with the fake `gh` over `state`. `values` maps
 * the expressions of the step's env, such as `needs.verify.outputs.tag`, to their values. Returns
 * `{ status, stderr, state, mutations, output, summary }`.
 */
function runStep(step, state, values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-release-step-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const file = (name) => path.join(dir, name);
  fs.writeFileSync(file('state.json'), JSON.stringify(state));
  for (const name of ['calls', 'output', 'summary']) fs.writeFileSync(file(name), '');
  const env = {};
  for (const [name, expression] of Object.entries(step.env || {})) {
    const found = /^\$\{\{ (.+) \}\}$/.exec(expression);
    assert.ok(found && found[1] in values, `the test gives ${expression}`);
    env[name] = values[found[1]];
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: process.env.HOME,
      GITHUB_REPOSITORY: 'owner/action',
      GITHUB_OUTPUT: file('output'),
      GITHUB_STEP_SUMMARY: file('summary'),
      MOCK_STATE: file('state.json'),
      MOCK_LOG: file('calls'),
      ...env,
    },
  });
  const calls = fs
    .readFileSync(file('calls'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const run = {
    status: result.status,
    stderr: result.stderr,
    state: JSON.parse(fs.readFileSync(file('state.json'), 'utf8')),
    mutations: calls.filter((c) => c.includes('PATCH') || c.includes('POST')),
    output: fs.readFileSync(file('output'), 'utf8'),
    summary: fs.readFileSync(file('summary'), 'utf8'),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return run;
}

/**
 * The promote step of `tag`, given the outputs its verify job wrote when it started, which may be
 * stale by the time the promotion runs.
 */
function promote(state, { tag, sha }) {
  const major = tag.split('.')[0];
  return runStep(jobs.promote.steps[0], state, {
    'github.token': 'token',
    'needs.verify.outputs.tag': tag,
    'needs.verify.outputs.major': major,
    'needs.verify.outputs.release-sha': sha,
  });
}

describe('promoting the floating major against the published releases', () => {
  test('promotions of one major run one at a time, and only for a release still the highest', () => {
    assert.deepStrictEqual(jobs.promote.concurrency, {
      group: 'playwright-smart-parallelization-promote-${{ needs.verify.outputs.major }}',
      'cancel-in-progress': false,
      queue: 'max',
    });
    assert.match(jobs.promote.if, /needs\.verify\.outputs\.current == 'true'/);
    assert.strictEqual(jobs.verify.outputs.current, '${{ steps.order.outputs.current }}');
  });

  test('an older release promoted after a newer one leaves the major on the newer', () => {
    // v1.0.0 verified while it was the highest; v1.0.1 published, verified and promoted first.
    const state = {
      releases: published('v10.0.0', 'v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /v1\.0\.0 is older than v1\.0\.1/);
    assert.deepStrictEqual(run.mutations, []);
    assert.strictEqual(run.state.refs.v1.sha, SHA.v101);
  });

  test('the highest release moves its major, and a later older promotion does not undo it', () => {
    const state = {
      releases: published('v1.0.0', 'v1.0.1'),
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        // An annotated exact tag peels to its commit.
        'v1.0.1': { type: 'tag', sha: ANNOTATED },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: { [ANNOTATED]: { type: 'commit', sha: SHA.v101 } },
    };
    const newer = promote(state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.strictEqual(newer.status, 0, newer.stderr);
    assert.strictEqual(newer.mutations.length, 1);
    assert.ok(newer.mutations[0].includes('PATCH'));
    assert.strictEqual(newer.state.refs.v1.sha, SHA.v101);

    const older = promote(newer.state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(older.status, 0);
    assert.deepStrictEqual(older.mutations, []);
    assert.strictEqual(older.state.refs.v1.sha, SHA.v101);
  });

  test('the highest release is chosen by number, among the releases of its own major only', () => {
    const state = {
      // Lexically v1.0.9 sorts after v1.0.10, and v10.2.0 starts with v1.
      releases: published('v10.2.0', 'v1.0.9', 'v1.0.10'),
      refs: {
        'v1.0.9': { type: 'commit', sha: SHA.v100 },
        'v1.0.10': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: {},
    };
    const newer = promote(state, { tag: 'v1.0.10', sha: SHA.v101 });
    assert.strictEqual(newer.status, 0, newer.stderr);
    assert.strictEqual(newer.state.refs.v1.sha, SHA.v101);

    const older = promote(newer.state, { tag: 'v1.0.9', sha: SHA.v100 });
    assert.notStrictEqual(older.status, 0);
    assert.match(older.stderr, /v1\.0\.9 is older than v1\.0\.10/);
    assert.deepStrictEqual(older.mutations, []);
  });

  test('a newer release on a later page of the releases still keeps the major', () => {
    const state = {
      releases: published('v1.0.0', 'v1.0.1'),
      pageSize: 1,
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /v1\.0\.0 is older than v1\.0\.1/);
    assert.deepStrictEqual(run.mutations, []);
  });

  test('a major with no tag yet is created at the release', () => {
    const state = {
      releases: published('v1.0.0'),
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.mutations.length, 1);
    assert.ok(run.mutations[0].includes('POST'));
    assert.deepStrictEqual(run.state.refs.v1, { type: 'commit', sha: SHA.v100 });
  });

  test('two majors progress independently', () => {
    const state = {
      releases: published('v2.0.0', 'v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        'v2.0.0': { type: 'commit', sha: SHA.v200 },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: {},
    };
    const two = promote(state, { tag: 'v2.0.0', sha: SHA.v200 });
    assert.strictEqual(two.status, 0, two.stderr);
    assert.strictEqual(two.state.refs.v2.sha, SHA.v200);
    assert.strictEqual(two.state.refs.v1.sha, SHA.v100, 'v2 leaves v1 alone');

    // v2.0.0 is the highest release overall; v1.0.1 is still the highest of v1.
    const one = promote(two.state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.strictEqual(one.status, 0, one.stderr);
    assert.strictEqual(one.state.refs.v1.sha, SHA.v101);
    assert.strictEqual(one.state.refs.v2.sha, SHA.v200, 'v1 leaves v2 alone');
  });

  test('a repeated promotion to the same commit succeeds and changes nothing', () => {
    const state = {
      releases: published('v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.mutations, []);
    assert.match(run.summary, /v1 already resolves to b{40}/);
  });

  test('verify fails a release that a newer one superseded while it was verified', () => {
    const step = jobs.verify.steps[stepIndex('verify', 'Recheck the release order')];
    const values = (tag) => ({
      'github.token': 'token',
      'steps.release.outputs.tag': tag,
      'steps.release.outputs.major': 'v1',
    });
    const state = { releases: published('v1.0.1', 'v1.0.0', 'v10.0.0'), refs: {}, tags: {} };

    const older = runStep(step, state, values('v1.0.0'));
    assert.notStrictEqual(older.status, 0);
    assert.match(older.stderr, /v1\.0\.0 was superseded by v1\.0\.1/);
    assert.strictEqual(older.output, '', 'a superseded release has no current output');

    const current = runStep(step, state, values('v1.0.1'));
    assert.strictEqual(current.status, 0, current.stderr);
    assert.strictEqual(current.output, 'current=true\n');

    const paged = { ...state, releases: published('v1.0.0', 'v1.0.1'), pageSize: 1 };
    const later = runStep(step, paged, values('v1.0.0'));
    assert.notStrictEqual(later.status, 0, 'the newer release is on the second page');
    assert.match(later.stderr, /v1\.0\.0 was superseded by v1\.0\.1/);
  });

  test('a releases API that fails stops the promotion before any tag moves', () => {
    // v1.0.1 is the highest, but the read fails; a promotion of the older v1.0.0 must not proceed.
    const state = {
      releases: published('v1.0.1', 'v1.0.0'),
      releasesDown: true,
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /HTTP 502/);
    assert.deepStrictEqual(run.mutations, []);
    assert.strictEqual(run.state.refs.v1.sha, SHA.v101);
  });

  test('an exact tag on another commit aborts the promotion', () => {
    const state = {
      releases: published('v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.1': { type: 'commit', sha: SHA.other },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /v1\.0\.1 resolves to d{40} instead of b{40}/);
    assert.deepStrictEqual(run.mutations, []);
    assert.strictEqual(run.state.refs.v1.sha, SHA.v100);
  });
});
