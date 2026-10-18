'use strict';

/**
 * The bundled main step and finish action run in Node with `--throw-deprecation` against a local
 * stand-in for the Actions cache and artifact services: main pins its snapshot through a cache
 * save, or reads the pin through a cache restore, and uploads its start marker; finish lists and
 * downloads the markers. No step prints a deprecation warning, such as the DEP0005 `new Buffer()`
 * of the toolkit's unzip dependencies, which scripts/build.js patches out.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FIXTURE, requireFixture } = require('./support/fixture');
const { actionInputs, readInputs, ACTION_INPUTS } = require('../lib/inputs');
const { pinKey } = require('../lib/identity');

const DIST = path.join(__dirname, '..', 'dist');
const RUN_ID = 4242;
const SERVICE = 'github.actions.results.api.v1.ArtifactService';
const CACHE_SERVICE = 'github.actions.results.api.v1.CacheService';

/**
 * The services the toolkit talks to: the artifact service's Twirp JSON API for list, signed URL,
 * create and finalize, the cache service's for download URL, create and finalize, where a key is
 * created once, a blob store for the signed URLs, and the jobs API finish reads.
 */
function artifactService() {
  const artifacts = new Map();
  const uploads = new Map();
  const entries = new Map();
  let nextId = 1;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://localhost');
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname.startsWith(`/twirp/${CACHE_SERVICE}/`)) {
        const method = url.pathname.split('/').pop();
        const request = JSON.parse(body.toString() || '{}');
        if (method === 'GetCacheEntryDownloadURL') {
          const found = entries.get(request.key);
          if (!found || !found.final) return json(200, { ok: false });
          return json(200, {
            ok: true,
            signedDownloadUrl: `${base}/cache-blob/${encodeURIComponent(request.key)}?sig=x`,
            matchedKey: request.key,
          });
        }
        if (method === 'CreateCacheEntry') {
          if (entries.has(request.key)) return json(200, { ok: false, message: 'already exists' });
          entries.set(request.key, { parts: [], final: false });
          return json(200, {
            ok: true,
            signedUploadUrl: `${base}/cache-upload/${encodeURIComponent(request.key)}?sig=x`,
          });
        }
        if (method === 'FinalizeCacheEntryUpload') {
          entries.get(request.key).final = true;
          return json(200, { ok: true, entryId: '1' });
        }
        return json(404, { code: 'not_found', msg: method });
      }
      if (url.pathname.startsWith('/cache-upload/')) {
        const key = decodeURIComponent(url.pathname.slice('/cache-upload/'.length));
        if (url.searchParams.get('comp') !== 'blocklist') entries.get(key).parts.push(body);
        res.writeHead(201, { etag: '"1"', 'last-modified': new Date().toUTCString() });
        return res.end();
      }
      if (url.pathname.startsWith('/cache-blob/')) {
        const key = decodeURIComponent(url.pathname.slice('/cache-blob/'.length));
        const data = Buffer.concat(entries.get(key).parts);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': data.length,
        });
        return res.end(data);
      }
      if (url.pathname.startsWith(`/twirp/${SERVICE}/`)) {
        const method = url.pathname.split('/').pop();
        // The toolkit sends proto field names.
        const request = JSON.parse(body.toString() || '{}');
        if (method === 'ListArtifacts') {
          const list = [...artifacts.values()].filter(
            (a) =>
              (!request.name_filter || a.name === request.name_filter) &&
              (!request.id_filter || String(a.id) === String(request.id_filter))
          );
          return json(200, {
            artifacts: list.map((a) => ({
              workflowRunBackendId: 'run',
              workflowJobRunBackendId: 'job',
              databaseId: String(a.id),
              name: a.name,
              size: String(a.zip.length),
              createdAt: '2026-10-17T00:00:00Z',
            })),
          });
        }
        if (method === 'GetSignedArtifactURL') {
          const found = [...artifacts.values()].find((a) => a.name === request.name);
          return json(200, { signedUrl: `${base}/blob/${found.id}.zip?sig=x` });
        }
        if (method === 'CreateArtifact') {
          if ([...artifacts.values()].some((a) => a.name === request.name)) {
            return json(409, { code: 'already_exists', msg: 'an artifact with this name exists' });
          }
          uploads.set(request.name, []);
          return json(200, {
            ok: true,
            signedUploadUrl: `${base}/upload/${encodeURIComponent(request.name)}?sig=x`,
          });
        }
        if (method === 'FinalizeArtifact') {
          const id = nextId++;
          artifacts.set(request.name, {
            id,
            name: request.name,
            zip: Buffer.concat(uploads.get(request.name)),
          });
          return json(200, { ok: true, artifactId: String(id) });
        }
        return json(404, { code: 'not_found', msg: method });
      }
      if (url.pathname.startsWith('/upload/')) {
        const name = decodeURIComponent(url.pathname.slice('/upload/'.length));
        if (url.searchParams.get('comp') !== 'blocklist') uploads.get(name).push(body);
        res.writeHead(201, { etag: '"1"', 'last-modified': new Date().toUTCString() });
        return res.end();
      }
      if (url.pathname.startsWith('/blob/')) {
        const id = Number(path.basename(url.pathname, '.zip'));
        const found = [...artifacts.values()].find((a) => a.id === id);
        res.writeHead(200, { 'content-type': 'application/zip' });
        return res.end(found.zip);
      }
      if (url.pathname.endsWith('/jobs')) return json(200, { total_count: 0, jobs: [] });
      return json(404, {});
    });
  });
  return { server, artifacts, entries };
}

let service;
let ws;

/** The environment a runner gives a step of a job, with the inputs at their defaults. */
function stepEnv(step) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `psp-dist-${step}-`));
  const files = {};
  for (const name of ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) {
    files[name] = path.join(dir, name.toLowerCase());
    fs.writeFileSync(files[name], '');
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({ scp: 'Actions.Results:run:job' })}.x`;
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(GITHUB_|RUNNER_|ACTIONS_|PSP_|INPUT_|NODE_OPTIONS$)/.test(name)
    )
  );
  return {
    ...hostEnv,
    ...files,
    GITHUB_WORKSPACE: ws,
    GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'test',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SHA: 'c0ffee',
    GITHUB_API_URL: base,
    GITHUB_SERVER_URL: 'https://github.com',
    ACTIONS_RUNTIME_TOKEN: token,
    ACTIONS_RESULTS_URL: `${base}/`,
    ACTIONS_CACHE_SERVICE_V2: 'true',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_NAME: 'local',
    RUNNER_TEMP: dir,
    'INPUT_WORKING-DIRECTORY': '.',
    // No event payload names the default branch, so auto publishes nothing.
    'INPUT_PUBLISH-HISTORY': 'auto',
    'INPUT_GITHUB-TOKEN': 'token',
  };
}

/** Runs a bundled entry with `--throw-deprecation`: `{ status, stdout, stderr }`. */
function runEntry(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--throw-deprecation', file], { cwd: ws, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  requireFixture();
  // The real path, as the cache toolkit resolves the cached folders against the workspace.
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psp-dist-ws-')));
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(FIXTURE, file), path.join(ws, file));
  }
  service = artifactService();
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
});

after(() => service.server.close());

test('the bundled main step pins through the cache, reads the pin back, and uploads its marker with no deprecation', async () => {
  const env = stepEnv('main');
  const { key } = actionInputs(readInputs(ACTION_INPUTS, env), env);
  const pinned = await runEntry(path.join(DIST, 'main.js'), env);
  const output = `${pinned.stdout}${pinned.stderr}`;
  assert.strictEqual(pinned.status, 0, output);
  assert.doesNotMatch(output, /DeprecationWarning|DEP0\d{3}|::error/, output);
  assert.match(pinned.stdout, /pinned no history as psp-pin-v2-/);
  assert.match(pinned.stdout, /uploaded psp-start-test-/);
  assert.ok(service.entries.get(pinKey(key, 'test', RUN_ID)).final);
  assert.ok([...service.artifacts.keys()].some((name) => name.startsWith('psp-start-test-')));
  // Another shard of the job restores the pin the first one saved.
  const read = await runEntry(path.join(DIST, 'main.js'), stepEnv('main'));
  const again = `${read.stdout}${read.stderr}`;
  assert.strictEqual(read.status, 0, again);
  assert.doesNotMatch(again, /DeprecationWarning|DEP0\d{3}|::error/, again);
  assert.match(read.stdout, /read the pin psp-pin-v2-/);
});

test('the bundled finish action downloads the markers with no deprecation', async () => {
  const run = await runEntry(path.join(DIST, '..', 'finish', 'main.js'), stepEnv('finish'));
  const output = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(output, /DeprecationWarning|DEP0\d{3}/, output);
  assert.match(run.stdout, /SHA256 digest of downloaded artifact/);
  // The marker has no record, so finish fails its check, the way a shard that wrote none does.
  assert.match(run.stdout, /no shard of its job left a record/);
});
