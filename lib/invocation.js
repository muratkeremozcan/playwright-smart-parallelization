'use strict';

/**
 * The selection flags of the user's own `playwright test` command that the resolved config does
 * not show. `--no-deps` clears every dependency and teardown edge inside Playwright, yet the
 * public `FullProject.dependencies` and `teardown` keep their configured values, so the reporter
 * reads the flag from the command line. `--last-failed` filters the tests after the split, where
 * no reporter can see it, so the reporter refuses it before any test runs.
 *
 * The reporter runs in the Playwright process, so `process.argv` is that command. It is parsed the
 * way Playwright's option parser reads it: an option with a required value takes the next token
 * whatever it looks like (`--grep --no-deps` greps for the text `--no-deps`), an optional or a
 * variadic value takes only tokens that do not start with a dash, short flags combine (`-xc file`),
 * and `--` ends the options. An option Playwright does not know stops the run before any reporter
 * loads, so the table only needs the options that take values.
 */

/** The value of each option of `playwright test`: `required`, `optional` or `variadic`. */
const LONG = {
  'add-reporter': 'required',
  browser: 'required',
  config: 'required',
  debug: 'optional',
  'global-timeout': 'required',
  grep: 'required',
  'grep-invert': 'required',
  'last-failed-file': 'required',
  'max-failures': 'required',
  output: 'required',
  'only-changed': 'optional',
  project: 'variadic',
  'repeat-each': 'required',
  reporter: 'required',
  retries: 'required',
  'run-agents': 'required',
  shard: 'required',
  'shard-weights': 'required',
  shuffle: 'optional',
  'test-list': 'required',
  'test-list-invert': 'required',
  timeout: 'required',
  trace: 'required',
  tsconfig: 'required',
  'ui-host': 'required',
  'ui-port': 'required',
  'update-snapshots': 'optional',
  'update-source-method': 'required',
  workers: 'required',
};
const SHORT = { c: 'required', g: 'required', G: 'required', j: 'required', u: 'optional' };

const isOption = (token) => token.length > 1 && token.startsWith('-');

/**
 * `{ noDeps, lastFailed }` of a `playwright test` command line. Throws when `argv` holds no
 * `test` command, since the flags of another command line say nothing about this run.
 */
function parseInvocation(argv) {
  const args = argv.slice(2);
  const at = args.findIndex((token) => !isOption(token));
  if (at === -1 || args[at] !== 'test') {
    throw new Error(
      `cannot find the playwright test command in the command line ${JSON.stringify(argv.slice(1))}, ` +
        'so --no-deps and --last-failed cannot be read; run the reporter through $PSP_ARGS in a ' +
        'playwright test command'
    );
  }
  const found = { noDeps: false, lastFailed: false };
  const tokens = args.slice(at + 1);
  // Skips the tokens a value of `kind` takes from `i`, the index of the token after its option.
  const skipValue = (kind, i) => {
    if (kind === 'required') return i + 1;
    if (kind === 'optional') return i < tokens.length && !isOption(tokens[i]) ? i + 1 : i;
    let next = i;
    while (next < tokens.length && !isOption(tokens[next])) next++;
    return next;
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i++];
    if (token === '--') break;
    if (!isOption(token)) continue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = token.slice(2, eq === -1 ? undefined : eq);
      if (name === 'no-deps') found.noDeps = true;
      else if (name === 'last-failed') found.lastFailed = true;
      const kind = LONG[name];
      if (kind && eq === -1) i = skipValue(kind, i);
      else if (kind === 'variadic') i = skipValue(kind, i);
      continue;
    }
    for (let c = 1; c < token.length; c++) {
      const kind = SHORT[token[c]];
      if (!kind) continue;
      if (c + 1 < token.length) break;
      i = skipValue(kind, i);
    }
  }
  return found;
}

module.exports = { parseInvocation };
