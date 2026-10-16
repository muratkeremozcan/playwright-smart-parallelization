'use strict';

/**
 * Runs `action.yml` locally, step by step, the way the runner runs a composite action: each step's
 * `if` is evaluated against the inputs and the outputs and outcomes of the steps before it,
 * `${{ }}` expressions are filled in, `run` steps run with bash and write their outputs to
 * `GITHUB_OUTPUT`, and the official actions the composite uses are modeled on a shared `world`:
 *
 * - `actions/cache/restore` and `actions/cache/save`: immutable keys, a save onto an existing key
 *   changes nothing, an exact key wins and otherwise a restore key returns the newest entry created
 *   with that prefix (what GitHub documents);
 * - `actions/upload-artifact` and `actions/download-artifact`: artifacts by name for one run, a
 *   pattern download puts one match straight into the path and several into folders of their
 *   names (what download-artifact does).
 *
 * `hooks.before(step, world)` runs before a step, so a test can let another writer act between two
 * steps of the unrolled compare-and-swap.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const ACTION = YAML.parse(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));

function newWorld() {
  return { cache: new Map(), created: 0, artifacts: new Map(), log: [] };
}

function readTree(source) {
  const files = {};
  if (!fs.existsSync(source)) return files;
  if (fs.statSync(source).isFile()) {
    files[path.basename(source)] = fs.readFileSync(source);
    return files;
  }
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else files[rel] = fs.readFileSync(full);
    }
  };
  walk(source, '');
  return files;
}

function writeTree(target, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(target, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Saves `files` under `key` unless the key exists. Returns whether it saved. */
function cacheSave(world, key, files) {
  if (world.cache.has(key)) {
    world.log.push(`cache save skipped, ${key} exists`);
    return false;
  }
  world.cache.set(key, { files, created: ++world.created });
  world.log.push(`cache saved ${key}`);
  return true;
}

function cacheRestore(world, key, restoreKeys = []) {
  if (world.cache.has(key)) return { hit: true, matched: key, entry: world.cache.get(key) };
  for (const prefix of restoreKeys) {
    let best = null;
    for (const [name, entry] of world.cache) {
      if (name.startsWith(prefix) && (!best || entry.created > best.entry.created)) {
        best = { matched: name, entry };
      }
    }
    if (best) return { hit: false, ...best };
  }
  return { hit: false, matched: '', entry: null };
}

const globToRegex = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  );

const USES = {
  'actions/cache/restore': ({ with: w, world, workspace }) => {
    const restoreKeys = (w['restore-keys'] || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const found = cacheRestore(world, w.key, restoreKeys);
    if (found.entry) writeTree(path.join(workspace, w.path), found.entry.files);
    return {
      outputs: {
        'cache-hit': found.hit ? 'true' : 'false',
        'cache-primary-key': w.key,
        'cache-matched-key': found.matched,
      },
    };
  },
  'actions/cache/save': ({ with: w, world, workspace }) => {
    cacheSave(world, w.key, readTree(path.join(workspace, w.path)));
    return { outputs: {} };
  },
  'actions/upload-artifact': ({ with: w, world, workspace }) => {
    const files = readTree(path.resolve(workspace, w.path));
    if (Object.keys(files).length === 0) {
      if (w['if-no-files-found'] === 'error') throw new Error(`no files at ${w.path}`);
      return { outputs: {} };
    }
    if (world.artifacts.has(w.name) && w.overwrite !== 'true') {
      throw new Error(`an artifact named ${w.name} exists`);
    }
    world.artifacts.set(w.name, files);
    return { outputs: {} };
  },
  'actions/download-artifact': ({ with: w, world, workspace }) => {
    const target = path.resolve(workspace, w.path || '.');
    if (w.name) {
      if (!world.artifacts.has(w.name)) throw new Error(`Artifact '${w.name}' not found`);
      writeTree(target, world.artifacts.get(w.name));
      return { outputs: {} };
    }
    const pattern = globToRegex(w.pattern || '*');
    const names = [...world.artifacts.keys()].filter((name) => pattern.test(name)).sort();
    for (const name of names) {
      writeTree(names.length === 1 ? target : path.join(target, name), world.artifacts.get(name));
    }
    return { outputs: {} };
  },
};

const STATUS_FUNCTION = /\b(always|success|failure|cancelled)\(\)/;

/**
 * The host environment without what a runner sets for its own job: run inside a CI job, the model
 * must not see that job's event, ref or runner.
 */
const hostEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GITHUB_|RUNNER_|ACTIONS_|PSP_)/.test(name))
  );

/** A push to the default branch, the event of a run that publishes under `publish-history: auto`. */
function pushEvent(dir) {
  const file = path.join(dir, 'event.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify({ ref: 'refs/heads/main', repository: { default_branch: 'main' } })
    );
  }
  return file;
}

/** Evaluates a GitHub expression body against `ctx`. Supports what action.yml uses. */
function evaluate(expression, ctx) {
  const tokens = expression.match(
    /'(?:[^']|'')*'|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*\(\)|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+|==|!=|&&|\|\||!|\(|\)|\S/g
  );
  const js = tokens
    .map((token) => {
      if (token.startsWith("'")) return JSON.stringify(token.slice(1, -1).replace(/''/g, "'"));
      if (token === '==') return '===';
      if (token === '!=') return '!==';
      if (token === 'always()') return 'true';
      if (token === 'success()') return String(!ctx.failed);
      if (token === 'failure()') return String(ctx.failed);
      if (token === 'cancelled()') return 'false';
      if (/^[A-Za-z_]/.test(token)) return JSON.stringify(lookup(token, ctx));
      return token;
    })
    .join(' ');
  return Function(`"use strict"; return (${js});`)();
}

function lookup(ref, ctx) {
  const [root, ...rest] = ref.split('.');
  if (root === 'inputs') return ctx.inputs[rest.join('.')] ?? '';
  if (root === 'steps') {
    const step = ctx.steps[rest[0]];
    if (!step) return '';
    if (rest[1] === 'outcome') return step.outcome;
    if (rest[1] === 'outputs') return step.outputs[rest.slice(2).join('.')] ?? '';
    return '';
  }
  if (root === 'github' && rest[0] === 'token') return ctx.token || '';
  if (root === 'true') return true;
  if (root === 'false') return false;
  throw new Error(`unsupported expression reference ${ref}`);
}

const interpolate = (value, ctx) =>
  String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, body) => {
    const result = evaluate(body, ctx);
    return result === undefined || result === null ? '' : String(result);
  });

function readOutputs(file) {
  const outputs = {};
  if (!fs.existsSync(file)) return outputs;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([\w-]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const value = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) value.push(lines[i]);
      outputs[heredoc[1]] = value.join('\n');
    } else if (lines[i].includes('=')) {
      const at = lines[i].indexOf('=');
      outputs[lines[i].slice(0, at)] = lines[i].slice(at + 1);
    }
  }
  return outputs;
}

/**
 * Runs the composite with `inputs` (defaults filled from action.yml) in `workspace`. `env` adds to
 * the step environment (GITHUB_RUN_ID and friends). Returns `{ outcome, outputs, steps, stdout,
 * summary }`.
 */
function runAction({ inputs = {}, env = {}, world, workspace, hooks = {} }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-composite-'));
  const runnerTemp = env.RUNNER_TEMP || path.join(temp, 'runner-temp');
  fs.mkdirSync(runnerTemp, { recursive: true });
  const filled = {};
  for (const [name, spec] of Object.entries(ACTION.inputs)) {
    filled[name] = inputs[name] !== undefined ? String(inputs[name]) : String(spec.default ?? '');
  }
  const ctx = { inputs: {}, steps: {}, failed: false, token: env.TOKEN || '' };
  ctx.inputs = Object.fromEntries(
    Object.entries(filled).map(([k, v]) => [k, interpolate(v, { ...ctx, inputs: {} })])
  );
  const summaryFile = path.join(temp, 'summary.md');
  let stdout = '';
  const steps = [];
  try {
    ACTION.runs.steps.forEach((step, index) => {
      // Like the runner, an `if:` without a status function also requires success().
      const condition = !step.if
        ? !ctx.failed
        : STATUS_FUNCTION.test(step.if)
          ? evaluate(step.if, ctx)
          : !ctx.failed && evaluate(step.if, ctx);
      const record = {
        id: step.id || `step-${index}`,
        name: step.name,
        ran: false,
        outcome: 'skipped',
        outputs: {},
      };
      steps.push(record);
      if (step.id) ctx.steps[step.id] = record;
      if (!condition) return;
      if (hooks.before) hooks.before(step, world);
      record.ran = true;
      try {
        if (step.uses) {
          const name = step.uses.replace(/@.*$/, '');
          const handler = USES[name];
          if (!handler) throw new Error(`no model for ${step.uses}`);
          const w = Object.fromEntries(
            Object.entries(step.with || {}).map(([k, v]) => [k, interpolate(v, ctx)])
          );
          record.outputs = handler({ with: w, world, workspace }).outputs;
          record.outcome = 'success';
        } else {
          const outputFile = path.join(temp, `output-${index}`);
          const stepEnv = Object.fromEntries(
            Object.entries(step.env || {}).map(([k, v]) => [k, interpolate(v, ctx)])
          );
          const result = spawnSync('bash', ['-c', step.run], {
            cwd: workspace,
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
            env: {
              ...hostEnv(),
              GITHUB_RUN_ID: '1000',
              GITHUB_RUN_ATTEMPT: '1',
              GITHUB_SHA: 'c0ffee',
              GITHUB_REPOSITORY: 'owner/repo',
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              // A fixed day, so a chain the model starts has a known epoch.
              PSP_TODAY: '2026-10-16',
              GITHUB_EVENT_PATH: pushEvent(temp),
              RUNNER_OS: 'Linux',
              RUNNER_ARCH: 'X64',
              RUNNER_NAME: 'local',
              ...env,
              ...stepEnv,
              GITHUB_ACTION_PATH: ROOT,
              GITHUB_WORKSPACE: workspace,
              RUNNER_TEMP: runnerTemp,
              GITHUB_OUTPUT: outputFile,
              GITHUB_STEP_SUMMARY: summaryFile,
            },
          });
          stdout += `${result.stdout || ''}${result.stderr || ''}`;
          record.outputs = readOutputs(outputFile);
          record.outcome = result.status === 0 ? 'success' : 'failure';
        }
      } catch (error) {
        stdout += `model error in ${step.name}: ${error.message}\n`;
        record.outcome = 'failure';
      }
      if (record.outcome === 'failure') ctx.failed = true;
    });
    const outputs = Object.fromEntries(
      Object.entries(ACTION.outputs || {}).map(([k, spec]) => [k, interpolate(spec.value, ctx)])
    );
    return {
      outcome: ctx.failed ? 'failure' : 'success',
      outputs,
      steps,
      stdout,
      summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '',
      runnerTemp,
    };
  } finally {
    if (!env.RUNNER_TEMP) fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { ACTION, cacheRestore, cacheSave, evaluate, newWorld, runAction };
