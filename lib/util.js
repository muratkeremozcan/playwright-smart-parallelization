'use strict';

/**
 * Small helpers every phase shares: hashing, canonical JSON, atomic writes and the workflow
 * commands GitHub Actions reads from a step (outputs, the job summary, annotations). Zero runtime
 * dependencies, and nothing newer than Node 18, because a composite action runs on whatever `node`
 * the runner has on its `PATH`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A short form of a sha for log lines and tables. */
const short = (sha) => (sha ? String(sha).slice(0, 12) : '-');

/** A deep copy of `value` with the keys of every object sorted, so its JSON has one byte form. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** JSON with sorted keys and a final newline: the same value always gives the same bytes. */
const canonicalJson = (value) => `${JSON.stringify(sortKeys(value))}\n`;

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Escapes a workflow command message the way @actions/core does. */
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escapes a workflow command property value the way @actions/core does. */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

const TITLE = 'playwright-smart-parallelization';

function errorCommand(message, title = TITLE) {
  return `::error title=${escapeProperty(title)}::${escapeData(message)}`;
}

function warningCommand(message, title = TITLE) {
  return `::warning title=${escapeProperty(title)}::${escapeData(message)}`;
}

/**
 * Sets a step output the way @actions/core does, with a delimiter the value cannot contain. Without
 * `GITHUB_OUTPUT` (a local run or a test) the outputs go to `sink` when one is given.
 */
function setOutputs(outputs, env = process.env, sink = null) {
  if (sink) Object.assign(sink, outputs);
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  let text = '';
  for (const [name, raw] of Object.entries(outputs)) {
    const value = String(raw);
    let delimiter = `psp_${crypto.randomBytes(8).toString('hex')}`;
    while (value.includes(delimiter)) delimiter = `psp_${crypto.randomBytes(8).toString('hex')}`;
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  fs.appendFileSync(file, text);
}

/** Appends markdown to the job summary, when the step has one. */
function appendSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
}

/** Milliseconds as people read them: 9.1s, 42s, 3m05s, 1h02m. */
function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Compares two dotted versions by their numeric parts: -1, 0 or 1. */
function compareVersions(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

module.exports = {
  TITLE,
  appendSummary,
  canonicalJson,
  compareVersions,
  errorCommand,
  escapeData,
  escapeProperty,
  formatMs,
  readJsonFile,
  setOutputs,
  sha256,
  short,
  sortKeys,
  warningCommand,
  writeAtomic,
};
