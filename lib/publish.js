'use strict';

/**
 * The post step of the Action, once per shard job after every other step, whatever they did. It
 * reads the record the reporter wrote, uploads it as a small artifact for the finish action, and
 * merges this shard's passing samples into the history by compare-and-swap (lib/store.js) when
 * the run may publish (lib/trust.js). A failed test leaves the samples of the tests that passed,
 * which are published like any other. It never touches the user's reports or artifacts, and a
 * problem here is a warning: the user's Playwright step already decided the job.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATUS_SCHEMA, RECORD_VERSION, validateRecord } = require('./check');
const { runSamples } = require('./history');
const { recordName } = require('./identity');
const { attemptsFor, newState, publish } = require('./store');
const { trust } = require('./trust');
const { readJsonFile, writeAtomic } = require('./util');

/** The artifact a disabled shard leaves, so finish can tell a rollback from shards that never ran. */
async function uploadStatus(state, { env, artifacts, io }) {
  const status = {
    schema: STATUS_SCHEMA,
    version: RECORD_VERSION,
    mode: 'disabled',
    run: { id: state.runId, attempt: state.attempt },
    key: state.key,
    job: state.job,
    historyKey: state.historyKey,
  };
  const dir = fs.mkdtempSync(
    path.join(env.RUNNER_TEMP || require('node:os').tmpdir(), 'psp-status-')
  );
  const file = path.join(dir, 'status.json');
  writeAtomic(file, `${JSON.stringify(status)}\n`);
  const name =
    `psp-record-${state.job}-${state.key.slice(0, 12)}-disabled-` +
    `${crypto.randomBytes(6).toString('hex')}-attempt-${state.attempt}`;
  await artifacts.upload(name, [file], dir);
  io.info(`uploaded ${name}`);
}

async function post({ env = process.env, io, state, cache, artifacts, sleep }) {
  if (!state) {
    io.info('the main step of the Action did not finish, so there is nothing to publish');
    return;
  }
  try {
    if (state.mode === 'disabled') {
      await uploadStatus(state, { env, artifacts, io });
      return;
    }
    if (!fs.existsSync(state.record)) {
      io.warning(
        'no run record: add $PSP_ARGS to the Playwright command after this step, so the ' +
          "Action's reporter runs; nothing is published for this shard"
      );
      return;
    }
    const record = validateRecord(readJsonFile(state.record), 'the run record');
    if (record.key !== state.key || record.run.id !== state.runId) {
      io.warning('the run record belongs to another key or run; nothing is published');
      return;
    }
    const name = recordName(record);
    try {
      await artifacts.upload(name, [state.record], path.dirname(state.record));
      io.info(`uploaded ${name}`);
    } catch (error) {
      io.warning(`the run record could not be uploaded as ${name}: ${error.message}`);
    }

    const samples = runSamples([record]);
    const allowed = trust(env, state.publish);
    let why = null;
    if (!state.cache) why = 'the Actions cache cannot be written by this job';
    else if (!allowed.trusted) why = allowed.reason;
    else if (samples.size === 0) why = 'no test of this shard passed';
    if (why) {
      io.info(`history not published: ${why}`);
      return;
    }
    const store = newState({
      key: state.key,
      pinned: state.slot,
      attempts: attemptsFor(record.shard.total),
      run: {
        id: state.runId,
        attempt: state.attempt,
        commit: state.commit,
        fingerprint: record.fingerprint || '',
        date: (env.PSP_TODAY || new Date().toISOString()).slice(0, 10),
        samples: [...samples],
      },
    });
    await publish(store, { cache, workspace: env.GITHUB_WORKSPACE || process.cwd(), sleep });
    for (const line of store.log) io.info(line);
    for (const error of store.errors) io.warning(error);
    if (store.status === 'failed') {
      io.warning(
        `the samples of shard ${record.shard.current}/${record.shard.total} were not published; the next run plans without them`
      );
    } else if (store.status === 'published') {
      io.info(
        `published ${samples.size} samples of shard ${record.shard.current}/${record.shard.total}`
      );
    }
  } catch (error) {
    io.warning(`the post step failed: ${error.message}`);
  }
}

module.exports = { post };
