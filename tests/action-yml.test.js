/**
 * Tests for action.yml, the public interface of the action.
 *
 * A step env that forgets an input changes what the action receives without changing anything
 * visible, so the wiring is pinned here: every declared input reaches the step under the
 * INPUT_ name that `getInput` style readers use, and nothing undeclared does.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const action = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8'));
const inputs = Object.entries(action.inputs);
const [step] = action.runs.steps;

describe('action.yml inputs', () => {
  test('declares the planned workflow inputs', () => {
    assert.deepStrictEqual(Object.keys(action.inputs).sort(), [
      'config-path',
      'enabled',
      'filters',
      'projects',
      'retention-days',
      'shard-count',
      'timing-artifact-name',
      'workers',
      'working-directory',
    ]);
  });

  test('every input is provisional, optional and has a string default', () => {
    for (const [name, input] of inputs) {
      assert.match(input.description, /^\s*Provisional\./, `${name} must be marked provisional`);
      assert.strictEqual(input.required, false, `${name} must be optional`);
      assert.strictEqual(typeof input.default, 'string', `${name} needs a string default`);
    }
  });

  test('the rollback switch defaults to balancing on', () => {
    assert.strictEqual(action.inputs.enabled.default, 'true');
  });
});

describe('action.yml runs', () => {
  test('is a composite action whose only step runs main.js from the action path', () => {
    assert.strictEqual(action.runs.using, 'composite');
    assert.strictEqual(action.runs.steps.length, 1);
    assert.strictEqual(step.shell, 'bash');
    assert.strictEqual(step.run, 'node "$GITHUB_ACTION_PATH/main.js"');
    assert.strictEqual(
      step.uses,
      undefined,
      'no third-party action may sit between a PR and the run'
    );
  });

  test('maps every input to INPUT_<NAME> and nothing else', () => {
    const expected = Object.fromEntries(
      inputs.map(([name]) => [`INPUT_${name.toUpperCase()}`, `\${{ inputs.${name} }}`])
    );
    assert.deepStrictEqual(step.env, expected);
  });
});

describe('action.yml run line, executed as a consumer runs it', () => {
  test('fails with the not-implemented annotation from the action path', () => {
    const result = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: path.join(__dirname, '..'),
        ...Object.fromEntries(Object.entries(step.env).map(([key]) => [key, 'x'])),
      },
      cwd: os.tmpdir(),
    });
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stdout, /^::error title=.*::.*not implemented yet/);
  });
});
