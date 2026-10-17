'use strict';

/**
 * Tests for the Release workflow. It writes tags and releases with the repository token, so it
 * keeps its guards: least privilege per job, write jobs that run no repository code, every gate and
 * the Action smoke before a draft and again before the floating major tag moves, the immutable and
 * Marketplace checks, and the tag handling that never moves an exact tag or rolls a major back.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

  test('runs one release at a time and never cancels one midway', () => {
    assert.strictEqual(WORKFLOW.concurrency.group, 'playwright-smart-parallelization-release');
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
    for (const name of ['verify', 'promote']) {
      assert.strictEqual(
        jobs[name].if,
        "github.event_name == 'release' && github.event.action == 'published'"
      );
    }
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
    test(`${name} runs validate and the prepare smoke of the Action from this checkout`, () => {
      const steps = jobs[name].steps;
      const validate = stepIndex(name, 'Run the validate gates');
      const smoke = stepIndex(name, 'Run the deterministic Action smoke');
      const outputs = stepIndex(name, 'Require the smoke outputs');
      assert.strictEqual(steps[validate].run, 'npm run validate');
      assert.ok(stepIndex(name, 'Install dependencies') < validate);
      assert.ok(validate < smoke && smoke < outputs);

      const step = steps[smoke];
      assert.strictEqual(step.uses, './');
      assert.strictEqual(step.with.phase, 'prepare', 'only prepare, which writes no history');
      assert.strictEqual(step.with['working-directory'], 'fixtures/consumer');
      assert.match(step.with['history-key'], /github\.run_id.*github\.run_attempt/);
      assert.strictEqual(step.with.enabled, undefined, 'the smoke plans for real');

      const check = steps[outputs];
      assert.match(check.env.MODE, new RegExp(`steps\\.${step.id}\\.outputs\\.mode`));
      assert.match(check.run, /test "\$MODE" = native/);
      assert.match(check.run, /test "\$REASON" = 'no history yet'/);
      assert.match(check.run, /\{"shard":\[1,2\]\}/);
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
    assert.strictEqual(stepNames('verify').at(-1), 'Verify Marketplace publication');
  });

  test('prevents major-tag rollback and peels annotated tags to commits', () => {
    const move = jobs.promote.steps[0];
    assert.strictEqual(move.name, 'Move the floating major tag');
    assert.match(move.run, /if \[ "\$RELEASE_ORDER" -lt 0 \]/);
    assert.match(move.run, /while \[ "\$object_type" = 'tag' \]/);
    assert.match(move.run, /exact_sha=\$\(resolve_tag_commit "\$TAG"\)/);
    assert.match(move.run, /major_sha=\$\(resolve_tag_commit "\$MAJOR"\)/);
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
