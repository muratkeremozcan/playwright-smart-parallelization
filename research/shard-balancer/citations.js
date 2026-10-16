'use strict';

/**
 * Verifies the citations of the decisions. A citation is `{ source, file, lines, quote }`:
 * `source` is `upstream` (the `playwright-shard-balancer` repository at the commit the installed
 * version was published from, fetched from GitHub), `flakiness` (the installed
 * `@flakiness/playwright` package) or `playwright` (the Playwright installed in the fixture);
 * `lines` is a list of ranges such as `171-176,195-197`. A citation holds when every range is
 * inside the file and the quote, with whitespace collapsed, is in the text of the cited lines.
 */

const fs = require('node:fs');
const path = require('node:path');
const { FIXTURE, FLAKINESS, REPOSITORY } = require('./upstream');

const LOCAL = {
  flakiness: FLAKINESS,
  playwright: path.join(FIXTURE, 'node_modules'),
};

/** `171-176,195` as `[[171, 176], [195, 195]]`. */
function parseLines(lines) {
  return String(lines)
    .split(',')
    .map((part) => {
      const [from, to = from] = part.split('-').map(Number);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        throw new Error(`bad line range ${part}`);
      }
      return [from, to];
    });
}

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** Whether `quote` is in the cited lines of `text`. Returns `{ ok, reason }`. */
function verify(text, { lines, quote }) {
  const all = text.split('\n');
  const ranges = parseLines(lines);
  const outside = ranges.find(([, to]) => to > all.length);
  if (outside)
    return { ok: false, reason: `line ${outside[1]} is past the end (${all.length} lines)` };
  const cited = ranges.map(([from, to]) => all.slice(from - 1, to).join('\n')).join('\n');
  if (!collapse(cited).includes(collapse(quote)))
    return { ok: false, reason: 'quote not found at the cited lines' };
  return { ok: true, reason: null };
}

/** The URL of a file of the upstream repository at `commit`. */
function upstreamUrl(commit, file) {
  return `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file}`;
}

/**
 * GETs an upstream file, retrying a failed request or body read three times with a growing
 * pause, so one dropped connection does not fail every citation of a file. A 404 fails at once.
 */
async function fetchUpstream(url, { attempts = 4, pauseMs = 2000, get = fetch } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await get(url);
      if (response.ok) return await response.text();
      last = new Error(`GET ${url}: ${response.status}`);
      if (response.status === 404) break;
    } catch (error) {
      last = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
  }
  throw last;
}

/** Every distinct citation of a list of decisions, in order of first use. */
function citationsOf(entries) {
  const seen = new Map();
  for (const entry of entries) {
    for (const source of entry.sources) {
      const key = JSON.stringify([
        source.source || 'upstream',
        source.file,
        source.lines,
        source.quote,
      ]);
      if (!seen.has(key))
        seen.set(key, {
          source: source.source || 'upstream',
          file: source.file,
          lines: source.lines,
          quote: source.quote,
        });
    }
  }
  return [...seen.values()];
}

/**
 * Checks every citation. `fetchText(url)` reads an upstream file (global `fetch` by default; a
 * test passes a local reader). Returns the citations with `ok` and `reason` added.
 */
async function checkCitations(citations, { commit, fetchText } = {}) {
  const read = fetchText || fetchUpstream;
  const texts = new Map();
  const textOf = async (citation) => {
    const key = `${citation.source}:${citation.file}`;
    if (!texts.has(key)) {
      if (citation.source === 'upstream') texts.set(key, read(upstreamUrl(commit, citation.file)));
      else
        texts.set(
          key,
          Promise.resolve(fs.readFileSync(path.join(LOCAL[citation.source], citation.file), 'utf8'))
        );
    }
    return texts.get(key);
  };
  const results = [];
  for (const citation of citations) {
    let result;
    try {
      result = verify(await textOf(citation), citation);
    } catch (error) {
      result = { ok: false, reason: error.message };
    }
    results.push({ ...citation, ...result });
  }
  return results;
}

module.exports = { checkCitations, citationsOf, fetchUpstream, parseLines, upstreamUrl, verify };
