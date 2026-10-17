'use strict';

/**
 * Small helpers every step shares: hashing, canonical JSON, atomic writes and number formats.
 * Nothing newer than Node 20, because the reporter bundles them and runs in the user's own Node.
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

/**
 * Runs `fn` on every item with at most `limit` calls in flight and returns the results in the
 * order of the items. The first error rejects, after the calls already started have settled.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  const lane = async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = failed || { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed) throw failed.error;
  return results;
}

/**
 * Whether an artifact download failed because the artifact is gone: a re-run of the whole workflow
 * deletes the run's artifacts, while the toolkit's listing still returns them for minutes and a
 * download of one fails with 404. Only an artifact of an earlier attempt can be gone this way.
 */
const artifactGone = (error) =>
  Boolean(error) &&
  (error.name === 'ArtifactNotFoundError' || /\(404\) Not Found/.test(String(error.message)));

/** The attempt an artifact of this Action belongs to, from its `-attempt-<n>` suffix, or null. */
function artifactAttempt(name) {
  const found = /-attempt-(\d+)$/.exec(String(name));
  return found ? Number(found[1]) : null;
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
  artifactAttempt,
  artifactGone,
  canonicalJson,
  compareVersions,
  formatMs,
  mapLimit,
  readJsonFile,
  sha256,
  short,
  sortKeys,
  writeAtomic,
};
