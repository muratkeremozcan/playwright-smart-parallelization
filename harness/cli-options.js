'use strict';

/**
 * Which arguments of a Playwright command line are options and which are the values of options.
 * Playwright parses its command line with commander, and a value can look like a flag
 * (`--grep-invert --test-list` gives `--grep-invert` the pattern `--test-list`). The arity of each
 * option comes from `playwright test --help`, so this follows the installed Playwright and not a
 * hand-kept list.
 */

const { spawnSync } = require('node:child_process');

/**
 * Reads the options of a `playwright test --help` text into `Map(flag -> arity)`, where the arity
 * is `'none'`, `'required'` (`<value>`), `'optional'` (`[value]`) or `'variadic'` (`<value...>`).
 * A short alias maps to the same arity as its long flag.
 */
function parseOptionArity(help) {
  const arity = new Map();
  for (const line of help.split('\n')) {
    const match = /^ {2}((?:-\w, )?)(--?[\w-]+)(?: ([<[])([^>\]]+)[>\]])?(?= {2,}|\s*$)/.exec(line);
    if (!match) continue;
    const [, shortPart, name, open, value] = match;
    let kind = 'none';
    if (open) kind = value.endsWith('...') ? 'variadic' : open === '<' ? 'required' : 'optional';
    arity.set(name, kind);
    if (shortPart) arity.set(shortPart.slice(0, 2), kind);
  }
  return arity;
}

const cache = new Map();

/** The option arity of the Playwright installed at `cli`, from its own help text. */
function playwrightOptionArity(cli) {
  if (!cache.has(cli)) {
    const run = spawnSync(process.execPath, [cli, 'test', '--help'], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`playwright test --help failed: ${run.stderr}`);
    cache.set(cli, parseOptionArity(run.stdout));
  }
  return cache.get(cli);
}

/**
 * The options `args` pass, the way commander reads them, in order: each is `{ name, arg }`, where
 * `name` is the flag (`--grep`, `-g`) and `arg` the token that carries it. A value that follows an
 * option which takes one is not an option, whatever it looks like. A separator that no option
 * consumes is yielded as `--` and ends the options.
 */
function* optionsOf(args, arity) {
  // An optional value is taken only from a token that is not an option, so it never hides one.
  const takesNext = (kind, next) =>
    next !== undefined && (kind === 'required' || kind === 'variadic');
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      yield { name: '--', arg };
      return;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg : arg.slice(0, equals);
      yield { name, arg };
      if (equals === -1 && takesNext(arity.get(name), args[i + 1])) {
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      // A cluster of short flags: the first that takes a value ends it, the rest is that value.
      for (let j = 1; j < arg.length; j += 1) {
        const name = `-${arg[j]}`;
        yield { name, arg };
        const kind = arity.get(name);
        if (kind === undefined || kind === 'none') continue;
        if (j === arg.length - 1 && takesNext(kind, args[i + 1])) i += 1;
        break;
      }
    }
  }
}

/** Whether `args` pass one of `flags` as an option before any separator (see `optionsOf`). */
function passesOption(args, arity, flags) {
  const wanted = new Set(flags);
  for (const { name } of optionsOf(args, arity)) {
    if (name === '--') return false;
    if (wanted.has(name)) return true;
  }
  return false;
}

module.exports = { optionsOf, parseOptionArity, passesOption, playwrightOptionArity };
