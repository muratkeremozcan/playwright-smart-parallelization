/**
 * Tests for action.yml, the public interface of the action.
 *
 * The file is rendered by scripts/render-action.js, so it must equal that output. Every Node step
 * receives every input under its PSP_INPUT_ name except the token, which only the step that reads
 * the jobs API gets, the only actions it uses are GitHub's official
 * cache and artifact actions, and the compare-and-swap of the history is unrolled into exactly the
 * attempts the store counts.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { FILE, rendered } = require('../scripts/render-action');
const { INPUTS, envName } = require('../lib/inputs');
const { ATTEMPTS } = require('../lib/store');
const { CACHE_PATH } = require('../lib/identity');
const { STEPS } = require('../main');

const text = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
const action = YAML.parse(text);
const steps = action.runs.steps;
const nodeSteps = steps.filter((s) => s.run);

test('action.yml is the output of scripts/render-action.js', () => {
  assert.strictEqual(path.resolve(FILE), path.resolve(__dirname, '..', 'action.yml'));
  assert.strictEqual(text, rendered, 'run `node scripts/render-action.js --write`');
});

describe('inputs and outputs', () => {
  test('declares the inputs the steps read, phase required and the rest optional with defaults', () => {
    assert.deepStrictEqual(Object.keys(action.inputs).sort(), [...INPUTS].sort());
    assert.strictEqual(action.inputs.phase.required, true);
    for (const [name, input] of Object.entries(action.inputs)) {
      if (name === 'phase') continue;
      assert.strictEqual(input.required, false, name);
      assert.strictEqual(typeof input.default, 'string', name);
    }
    assert.strictEqual(action.inputs.enabled.default, 'true');
  });

  test('outputs the matrix, plan, mode and reason of prepare and the outcome of finish', () => {
    assert.deepStrictEqual(Object.keys(action.outputs).sort(), [
      'coverage',
      'history',
      'matrix',
      'mode',
      'overhead-ms',
      'plan',
      'reason',
    ]);
    assert.match(action.outputs.plan.value, /steps\.prepare\.outputs\.plan/);
    assert.match(
      action.outputs.mode.value,
      /steps\.prepare\.outputs\.mode \|\| steps\.finish\.outputs\.mode/
    );
    for (const name of ['coverage', 'history']) {
      assert.match(action.outputs[name].value, new RegExp(`steps\\.finish\\.outputs\\.${name}`));
    }
  });
});

describe('Marketplace metadata', () => {
  test('has the name, a description the listing shows whole, and branding', () => {
    assert.strictEqual(action.name, 'Playwright Smart Parallelization');
    assert.ok(action.description.length <= 125, 'the Marketplace cuts descriptions at 125');
    assert.match(action.branding.icon, /^[a-z0-9-]+$/);
    assert.ok(
      [
        'white',
        'black',
        'yellow',
        'blue',
        'green',
        'orange',
        'red',
        'purple',
        'gray-dark',
      ].includes(action.branding.color)
    );
  });
});

describe('steps', () => {
  test('is a composite action whose Node steps call main.js with a known step', () => {
    assert.strictEqual(action.runs.using, 'composite');
    for (const step of nodeSteps) {
      assert.strictEqual(step.shell, 'bash');
      const match = /^node "\$GITHUB_ACTION_PATH\/main\.js" ([\w-]+)$/.exec(step.run);
      assert.ok(match, step.run);
      assert.ok(STEPS[match[1]], `main.js has the step ${match[1]}`);
    }
  });

  test('the first step gets every input but the token; every later one only the inputs file', () => {
    const [first, ...rest] = nodeSteps;
    assert.strictEqual(first.id, 'inputs');
    assert.strictEqual(steps[0], first);
    for (const input of INPUTS.filter((i) => i !== 'github-token')) {
      assert.strictEqual(first.env[envName(input)], `\${{ inputs.${input} }}`, input);
    }
    for (const step of rest) {
      assert.strictEqual(step.env.PSP_INPUTS_FILE, '${{ steps.inputs.outputs.file }}', step.name);
      const inputs = Object.keys(step.env).filter((name) => name.startsWith('PSP_INPUT_'));
      assert.deepStrictEqual(
        inputs,
        step.id === 'finish-check' ? [envName('github-token')] : [],
        step.name
      );
    }
  });

  test('the plan appears in the env of exactly one step', () => {
    const holders = steps.filter((s) => s.env && envName('plan') in s.env);
    assert.strictEqual(holders.length, 1);
    assert.strictEqual((text.match(/PSP_INPUT_PLAN/g) || []).length, 1);
  });

  test('gives the token to the step that reads the jobs API and to no other step', () => {
    const holders = nodeSteps.filter((s) => envName('github-token') in s.env).map((s) => s.id);
    assert.deepStrictEqual(holders, ['finish-check']);
  });

  test('uses only the official cache and artifact actions, pinned to a major', () => {
    const uses = [...new Set(steps.filter((s) => s.uses).map((s) => s.uses))].sort();
    assert.deepStrictEqual(uses, [
      'actions/cache/restore@v6',
      'actions/cache/save@v6',
      'actions/download-artifact@v8',
      'actions/upload-artifact@v7',
    ]);
    for (const step of steps.filter((s) => s.uses && s.uses.startsWith('actions/cache'))) {
      assert.strictEqual(
        step.with.path,
        CACHE_PATH,
        'one cache path, so every entry has one version'
      );
    }
  });

  test(`unrolls ${ATTEMPTS} compare-and-swap attempts of read, write, save, clear, read back, verify`, () => {
    for (let k = 1; k <= ATTEMPTS; k++) {
      const ids = steps
        .filter((s) => s.name && s.name.startsWith(`History, attempt ${k},`))
        .map((s) => s.uses || s.run.split(' ').pop());
      assert.deepStrictEqual(ids, [
        'actions/cache/restore@v6',
        'store-write',
        'actions/cache/save@v6',
        'store-clear',
        'actions/cache/restore@v6',
        'store-verify',
      ]);
    }
    assert.ok(!steps.some((s) => s.name && s.name.startsWith(`History, attempt ${ATTEMPTS + 1},`)));
  });

  test('the record and blob uploads run after a failed Playwright step', () => {
    const uploads = steps.filter((s) => s.name && /^Run, upload/.test(s.name));
    assert.strictEqual(uploads.length, 2);
    for (const step of uploads) assert.match(step.if, /^always\(\)/);
  });
});
