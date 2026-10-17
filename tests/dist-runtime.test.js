'use strict';

/**
 * The bundled main step and finish action run in Node with `--throw-deprecation` against a local
 * stand-in for the Actions artifact service: main reads its pin through an artifact download and
 * uploads its start marker, finish lists and downloads the markers. No step prints a deprecation
 * warning, such as the DEP0005 `new Buffer()` of the toolkit's unzip dependencies, which
 * scripts/build.js patches out.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { FIXTURE, requireFixture } = require('./support/fixture');
const { actionInputs, readInputs, ACTION_INPUTS } = require('../lib/inputs');
const { pinName } = require('../lib/identity');
const { SCHEMA: PIN_SCHEMA } = require('../lib/pin');
const { canonicalJson } = require('../lib/util');

const DIST = path.join(__dirname, '..', 'dist');
const RUN_ID = 4242;
const SERVICE = 'github.actions.results.api.v1.ArtifactService';

/** A zip archive that stores `files` (`{ name: Buffer }`) uncompressed. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const fileName = Buffer.from(name);
    const crc = zlib.crc32(data);
    const header = (signature, size) => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(signature, 0);
      return b;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * The artifact service the toolkit talks to: the Twirp JSON API for list, signed URL, create and
 * finalize, a blob store for the signed URLs, and the jobs API finish reads.
 */
function artifactService() {
  const artifacts = new Map();
  const uploads = new Map();
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
  const add = (name, files) => {
    const id = nextId++;
    artifacts.set(name, { id, name, zip: zip(files) });
  };
  return { server, artifacts, add };
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
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_NAME: 'local',
    RUNNER_TEMP: dir,
    INPUT_ENABLED: 'true',
    'INPUT_WORKING-DIRECTORY': '.',
    'INPUT_PUBLISH-HISTORY': 'false',
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
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-dist-ws-'));
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(FIXTURE, file), path.join(ws, file));
  }
  service = artifactService();
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const env = stepEnv('pin');
  const prepared = actionInputs(readInputs(ACTION_INPUTS, env), env);
  service.add(pinName(prepared.key, 'test'), {
    'pin.json': Buffer.from(
      canonicalJson({
        schema: PIN_SCHEMA,
        version: 1,
        key: prepared.key,
        runId: RUN_ID,
        job: 'test',
        matchedKey: '',
        history: null,
        note: null,
      })
    ),
  });
});

after(() => service.server.close());

test('the bundled main step downloads its pin and uploads its marker with no deprecation', async () => {
  const run = await runEntry(path.join(DIST, 'main.js'), stepEnv('main'));
  const output = `${run.stdout}${run.stderr}`;
  assert.strictEqual(run.status, 0, output);
  assert.doesNotMatch(output, /DeprecationWarning|DEP0\d{3}|::error/, output);
  assert.match(run.stdout, /read the pin psp-pin-test-/);
  assert.match(run.stdout, /uploaded psp-start-test-/);
  assert.ok([...service.artifacts.keys()].some((name) => name.startsWith('psp-start-test-')));
});

test('the bundled finish action downloads the markers with no deprecation', async () => {
  const run = await runEntry(path.join(DIST, '..', 'finish', 'main.js'), stepEnv('finish'));
  const output = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(output, /DeprecationWarning|DEP0\d{3}/, output);
  assert.match(run.stdout, /SHA256 digest of downloaded artifact/);
  // The marker has no record, so finish fails its check, the way a shard that wrote none does.
  assert.match(run.stdout, /no shard of its job left a record/);
});
