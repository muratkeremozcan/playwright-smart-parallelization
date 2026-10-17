'use strict';

/**
 * Runs the Action locally the way a shard job runs it: the main step (lib/setup.js), the user's
 * own Playwright command with the variables the main step exported, and the post step
 * (lib/publish.js), then the finish action (lib/finish.js) in a job of its own. The toolkit is
 * replaced by models on a shared `world`:
 *
 * - the Actions cache: immutable keys; a save reserves its key at once and finalizes it one tick
 *   later, so a save onto a reserved or finalized key changes nothing and an exact restore of a
 *   key still uploading misses; a restore by prefix returns the newest entry created (what GitHub
 *   documents), and a lookup the key that restore would match;
 * - the artifact store, one per run, as the service behaves (measured on GitHub): a name is unique
 *   within one job only, so a second upload of it from the same job fails, while jobs that upload
 *   one name at once each create an artifact of it; an artifact becomes visible to `find`, `list`
 *   and `download` one tick after its upload starts; ids are not in the order of creation, and
 *   `find` returns the highest id of a name, as the toolkit does; a re-run of the whole workflow
 *   deletes every artifact of the run (`rerunAll`), a re-run of some jobs deletes none.
 *
 * `world.before(op, key)` runs before every cache operation, so a test can let another writer act
 * between two steps of a compare-and-swap.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('../../lib/setup');
const { post } = require('../../lib/publish');
const { finish } = require('../../lib/finish');
const { envName } = require('../../lib/inputs');

const ROOT = path.join(__dirname, '..', '..');
// The bundled reporter, the file the main step copies for $PSP_ARGS (tests/dist.test.js keeps it
// current with reporter/).
const REPORTER = path.join(ROOT, 'dist', 'reporter.js');

function newWorld() {
  return { cache: new Map(), created: 0, runs: new Map(), nextId: 1, log: [], before: null };
}

function readTree(source) {
  const files = {};
  if (!fs.existsSync(source)) return files;
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Saves `files` under `key` unless the key exists, at once. Returns whether it saved. */
function cacheSave(world, key, files) {
  if (world.cache.has(key)) return false;
  world.cache.set(key, { files, created: ++world.created, final: true });
  return true;
}

/** An exact hit, else the newest finalized entry of the first prefix that has one. */
function cacheRestore(world, key, restoreKeys = []) {
  const exact = world.cache.get(key);
  if (exact && exact.final) return { matched: key, entry: exact };
  for (const prefix of restoreKeys) {
    let best = null;
    for (const [name, entry] of world.cache) {
      if (entry.final && name.startsWith(prefix) && (!best || entry.created > best.entry.created)) {
        best = { matched: name, entry };
      }
    }
    if (best) return best;
  }
  return { matched: '', entry: null };
}

/** The cache adapter of lib/cache.js over `world`, for the shard job in `workspace`. */
function modelCache(world, workspace, { available = true, readable = true, writable = true } = {}) {
  return {
    writeDenied: false,
    available: () => available,
    readable: () => readable,
    writable: () => writable,
    async restore(dir, key, restoreKeys = []) {
      if (world.before) await world.before('restore', key);
      await tick();
      const found = cacheRestore(world, key, restoreKeys);
      if (found.entry) writeTree(path.join(workspace, dir), found.entry.files);
      return found.matched;
    },
    async lookup(dir, key, restoreKeys = []) {
      if (world.before) await world.before('lookup', key);
      await tick();
      return cacheRestore(world, key, restoreKeys).matched;
    },
    async save(dir, key) {
      if (world.before) await world.before('save', key);
      if (world.cache.has(key)) {
        world.log.push(`save skipped, ${key} exists`);
        return false;
      }
      const entry = { files: readTree(path.join(workspace, dir)), created: ++world.created };
      world.cache.set(key, entry);
      await tick();
      entry.final = true;
      world.log.push(`saved ${key}`);
      return true;
    },
  };
}

/** The artifact store of run `runId`: every artifact of it, in the order of creation. */
function runStore(world, runId) {
  const id = String(runId);
  if (!world.runs) world.runs = new Map();
  if (!world.runs.has(id)) world.runs.set(id, []);
  return world.runs.get(id);
}

/**
 * Ids out of the order of creation, like the service's: a later artifact may have a lower id. The
 * multiplication permutes the counters below the prime, so no two artifacts share an id.
 */
const nextArtifactId = (world) => {
  world.nextId += 1;
  return (world.nextId * 7919) % 104729;
};

/** A re-run of the whole workflow: the service deletes every artifact of the run. */
function rerunAll(world, runId) {
  runStore(world, runId).length = 0;
}

/**
 * The artifact client of one job of run `runId`. `job` names the job, so its own second upload of
 * a name fails; each call without one is a job of its own.
 */
function modelArtifacts(world, runId, job = Symbol('job')) {
  const store = runStore(world, runId);
  const visible = () => store.filter((a) => a.final);
  return {
    // Like the service: a name is created at once and becomes visible a tick later.
    async upload(name, files, root) {
      if (world.before) await world.before('upload', name);
      if (store.some((a) => a.name === name && a.job === job)) {
        throw new Error(
          `(409) Conflict: an artifact with this name already exists on the workflow run`
        );
      }
      const tree = {};
      for (const file of files) tree[path.relative(root, file)] = fs.readFileSync(file);
      const artifact = { name, id: nextArtifactId(world), files: tree, final: false, job };
      store.push(artifact);
      await tick();
      artifact.final = true;
      return { id: artifact.id };
    },
    async find(name) {
      if (world.before) await world.before('find', name);
      const found = visible()
        .filter((a) => a.name === name)
        .sort((a, b) => b.id - a.id)[0];
      return found ? { name, id: found.id } : null;
    },
    async list() {
      return visible().map((a) => ({ name: a.name, id: a.id }));
    },
    async download(artifactId, target) {
      const found = store.find((a) => a.id === artifactId);
      if (!found) throw new Error(`artifact ${artifactId} not found`);
      writeTree(target, found.files);
    },
  };
}

function modelIo() {
  const io = {
    exported: {},
    outputs: {},
    lines: [],
    warnings: [],
    summaryText: '',
    failed: null,
    info: (m) => io.lines.push(m),
    warning: (m) => io.warnings.push(m),
    exportVariable: (n, v) => {
      io.exported[n] = v;
    },
    setOutput: (n, v) => {
      io.outputs[n] = v;
    },
    setFailed: (m) => {
      io.failed = m;
    },
    summary: (m) => {
      io.summaryText += m;
    },
  };
  return io;
}

/** The host environment without what a runner sets for its own job. */
const hostEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(GITHUB_|RUNNER_|ACTIONS_|PSP_|INPUT_)/.test(name)
    )
  );

/** A push to the default branch, the event of a run that publishes under `publish-history: auto`. */
function pushEvent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-event-'));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ ref: 'refs/heads/main', repository: { default_branch: 'main' } })
  );
  return file;
}

function jobEnv(ctx, { runId, attempt = 1, job = 'test', inputs = {}, env = {} }) {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-runner-temp-'));
  return {
    ...hostEnv(),
    GITHUB_WORKSPACE: ctx.ws,
    GITHUB_RUN_ID: String(runId),
    GITHUB_RUN_ATTEMPT: String(attempt),
    GITHUB_JOB: job,
    GITHUB_SHA: 'c0ffee',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_PATH: ctx.event || (ctx.event = pushEvent()),
    // A fixed day, so a chain the model starts has a known epoch.
    PSP_TODAY: '2026-10-16',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_NAME: 'local',
    RUNNER_TEMP: runnerTemp,
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [envName(k), String(v)])),
    ...env,
  };
}

// A wait lets the other writers of the model move on.
const noSleep = () => new Promise((resolve) => setImmediate(resolve));

/** The main step of one shard job: `{ env, io, state, error }`. */
async function mainStep(ctx, options) {
  const env = jobEnv(ctx, options);
  const io = modelIo();
  // The main and post steps of one shard job share its artifact uploads.
  const jobId = Symbol('shard job');
  try {
    const state = await setup({
      env,
      io,
      cache: options.cache || modelCache(ctx.world, ctx.ws, options.cacheOptions),
      artifacts: modelArtifacts(ctx.world, env.GITHUB_RUN_ID, jobId),
      sleep: options.sleep || noSleep,
      reporter: options.reporter || REPORTER,
    });
    return { env, io, state, error: null, jobId };
  } catch (error) {
    return { env, io, state: null, error, jobId };
  }
}

/** The user's step: `command` in bash, in `cwd` under the workspace, with the exported variables. */
function userStep(ctx, main, command, { cwd = '.', env = {} } = {}) {
  const result = spawnSync('bash', ['-c', command], {
    cwd: path.join(ctx.ws, cwd),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...main.env, ...main.io.exported, ...env },
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** The post step of the same job. */
async function postStep(ctx, main, options = {}) {
  const io = modelIo();
  await post({
    env: main.env,
    io,
    state: main.state,
    cache: options.cache || modelCache(ctx.world, ctx.ws),
    artifacts: modelArtifacts(ctx.world, main.env.GITHUB_RUN_ID, main.jobId),
    sleep: noSleep,
  });
  return io;
}

/** One shard job: main, the user's command, post. */
async function shardJob(ctx, options) {
  const main = await mainStep(ctx, options);
  if (main.error) return { main, user: null, post: null };
  const user = userStep(ctx, main, options.command, options);
  const postIo = await postStep(ctx, main, options);
  return { main, user, post: postIo };
}

/** The finish action in a job of its own. */
async function finishJob(ctx, { runId, inputs = {}, env = {}, fetchImpl = null }) {
  const io = modelIo();
  const result = await finish({
    env: jobEnv(ctx, { runId, job: 'finish', inputs, env }),
    io,
    artifacts: modelArtifacts(ctx.world, runId),
    fetchImpl: fetchImpl || (async () => ({ status: 404, ok: false })),
  });
  return { io, result };
}

module.exports = {
  REPORTER,
  cacheRestore,
  cacheSave,
  finishJob,
  mainStep,
  modelArtifacts,
  modelCache,
  modelIo,
  newWorld,
  rerunAll,
  runStore,
  postStep,
  shardJob,
  userStep,
};
