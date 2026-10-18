'use strict';

/** Whether a run may write the history, under the `publish-history` input. */

const { readJsonFile } = require('./util');

/**
 * Whether this run may publish, under `publish-history` (`mode`). A pull request from a fork and
 * any `pull_request_target` run never publish: they read the base history like any run. `auto`
 * publishes from the repository's default branch only, because a cache entry saved on another ref
 * is visible to that ref alone and would leave it reading its own stale entries. `true` also
 * publishes from same-repository branches and pull requests, into their own cache scope.
 */
function trust(env = process.env, mode = 'auto') {
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    return { trusted: false, reason: 'a pull_request_target run never publishes history' };
  }
  let event = null;
  try {
    if (env.GITHUB_EVENT_PATH) event = readJsonFile(env.GITHUB_EVENT_PATH);
  } catch {
    return { trusted: false, reason: 'the event payload is unreadable' };
  }
  const pr = event && event.pull_request;
  if (pr) {
    const head = pr.head && pr.head.repo && pr.head.repo.full_name;
    if (!head || head !== env.GITHUB_REPOSITORY) {
      return {
        trusted: false,
        reason: `pull request from ${head || 'a deleted fork'}, which does not publish history`,
      };
    }
    if (mode === 'auto') {
      return {
        trusted: false,
        reason:
          'publish-history auto publishes from the default branch only, and this run is a pull request',
      };
    }
    return { trusted: true, reason: null };
  }
  if (mode === 'true') return { trusted: true, reason: null };
  // GitHub runs scheduled workflows on the default branch only, and their payload may carry no
  // repository object to name it.
  if (env.GITHUB_EVENT_NAME === 'schedule' && (env.GITHUB_REF || '').startsWith('refs/heads/')) {
    return { trusted: true, reason: null };
  }
  const branch = event && event.repository && event.repository.default_branch;
  if (!branch) {
    return { trusted: false, reason: 'the default branch is unknown from the event payload' };
  }
  if (env.GITHUB_REF !== `refs/heads/${branch}`) {
    return {
      trusted: false,
      reason: `publish-history auto publishes from ${branch} only; this run is on ${env.GITHUB_REF || 'no ref'}`,
    };
  }
  return { trusted: true, reason: null };
}

/**
 * Whether this run is on the repository's default branch, so it reads and writes one cache scope:
 * a run on another ref also reads the default branch's entries, and a key can then hold other
 * bytes in each scope.
 */
function onDefaultBranch(env = process.env) {
  if (env.GITHUB_EVENT_NAME === 'schedule') return (env.GITHUB_REF || '').startsWith('refs/heads/');
  let event = null;
  try {
    if (env.GITHUB_EVENT_PATH) event = readJsonFile(env.GITHUB_EVENT_PATH);
  } catch {
    return false;
  }
  if (!event || event.pull_request) return false;
  const branch = event.repository && event.repository.default_branch;
  return Boolean(branch) && env.GITHUB_REF === `refs/heads/${branch}`;
}

module.exports = { onDefaultBranch, trust };
