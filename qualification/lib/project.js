'use strict';

/** Scratch directories and copies of the consumer project, shared by the engine qualifications. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `psp-${prefix}-`));
}

/**
 * Copies a consumer project into `dir` and applies `edits`, a map from a project-relative path to
 * new file content (or null to delete the file). The copy shares the original `node_modules`.
 * With `git`, the copy becomes a one-commit repository, for an engine that reads the commit.
 * Returns the path of the copy.
 */
function copyProject(source, dir, edits = {}, { git = false } = {}) {
  const target = path.join(dir, 'project');
  const skipped = new Set(['node_modules', 'test-results', 'playwright-report', 'blob-report']);
  fs.cpSync(source, target, {
    recursive: true,
    filter: (file) => !skipped.has(path.basename(file)),
  });
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(target, 'node_modules'));
  for (const [relative, content] of Object.entries(edits)) {
    const file = path.join(target, relative);
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
  if (git) commitAll(target);
  return target;
}

/** Turns `dir` into a git repository with one commit holding every file but `node_modules`. */
function commitAll(dir) {
  // No trailing slash: the copy links node_modules, and a slash only matches a directory.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  const identity = ['-c', 'user.name=psp', '-c', 'user.email=psp@example.invalid'];
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    [...identity, 'commit', '-q', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

module.exports = { commitAll, copyProject, tempDir, writeJson };
