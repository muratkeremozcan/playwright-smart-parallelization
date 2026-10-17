'use strict';

/**
 * The entry of the Action's bundle (`dist/index.js`, built by scripts/build.js): `run('main')`,
 * `run('post')` and `run('finish')` wire the steps of lib/ to the official `@actions/core`,
 * `@actions/cache` and `@actions/artifact` toolkit. Any error of the main or finish step fails it
 * with an error annotation; the post step only warns (lib/publish.js). Each step ends with a line
 * of the time its process took, from the start of Node to the end of the step, which the
 * repository's e2e workflow holds to a budget.
 */

const path = require('node:path');
const core = require('@actions/core');
const cache = require('@actions/cache');
const { DefaultArtifactClient } = require('@actions/artifact');
const { toolkitCache } = require('../lib/cache');
const { finish } = require('../lib/finish');
const { post } = require('../lib/publish');
const { setup } = require('../lib/setup');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const io = {
  info: (message) => core.info(`[playwright-smart-parallelization] ${message}`),
  warning: (message) => core.warning(message, { title: 'playwright-smart-parallelization' }),
  exportVariable: (name, value) => core.exportVariable(name, value),
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (message) => core.setFailed(message),
  summary: async (markdown) => {
    if (markdown) await core.summary.addRaw(markdown).write();
  },
};

function artifactClient() {
  const client = new DefaultArtifactClient();
  return {
    async find(name) {
      try {
        return (await client.getArtifact(name)).artifact;
      } catch (error) {
        if (error.name === 'ArtifactNotFoundError') return null;
        throw error;
      }
    },
    upload: (name, files, root) => client.uploadArtifact(name, files, root),
    list: async () => (await client.listArtifacts({ latest: true })).artifacts,
    download: (id, target) => client.downloadArtifact(id, { path: target }),
  };
}

const STEPS = {
  async main() {
    // The cache paths are relative to the workspace, so every shard computes one cache version.
    if (process.env.GITHUB_WORKSPACE) process.chdir(process.env.GITHUB_WORKSPACE);
    const state = await setup({
      io,
      cache: toolkitCache(cache),
      artifacts: artifactClient(),
      sleep,
      reporter: path.join(__dirname, 'reporter.js'),
    });
    core.saveState('state', JSON.stringify(state));
  },
  async post() {
    if (process.env.GITHUB_WORKSPACE) process.chdir(process.env.GITHUB_WORKSPACE);
    const raw = core.getState('state');
    await post({
      io,
      state: raw ? JSON.parse(raw) : null,
      cache: toolkitCache(cache),
      artifacts: artifactClient(),
      sleep,
    });
  },
  async finish() {
    await finish({ io, artifacts: artifactClient() });
  },
};

async function run(step) {
  try {
    await STEPS[step]();
  } catch (error) {
    if (step === 'post') core.warning(`the post step failed: ${error.message}`);
    else core.setFailed(error.message);
  }
  io.info(`the ${step} step took ${process.uptime().toFixed(2)}s`);
}

module.exports = { run };
