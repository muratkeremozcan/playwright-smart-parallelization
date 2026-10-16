'use strict';

/**
 * The user's test command. It is split into words the way a POSIX shell splits a simple command
 * (spaces, single quotes, double quotes, backslash escapes) and run without a shell, so the
 * Action can append its own arguments and nothing in the command is expanded twice. Shell syntax
 * that would change what runs (operators, redirections, substitutions, variables) is refused with
 * a message, since the Action could not tell where Playwright's arguments end.
 */

const SHELL_SYNTAX = new Set([';', '&', '|', '<', '>', '`', '$', '(', ')', '\n', '\r']);

/** Splits `command` into words. Throws on shell syntax and unbalanced quotes. */
function parseCommand(command) {
  const text = String(command || '').trim();
  if (!text) throw new Error('the command input is empty');
  const words = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === ' ' || char === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    inWord = true;
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error('the command has an unbalanced single quote');
      word += text.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && '"\\'.includes(text[j + 1] || '')) word += text[++j];
        else if (text[j] === '$' || text[j] === '`') {
          throw new Error(
            `the command uses "${text[j]}" inside double quotes; expand it in the workflow with \${{ }} instead`
          );
        } else word += text[j];
      }
      if (j >= text.length) throw new Error('the command has an unbalanced double quote');
      i = j;
    } else if (char === '\\') {
      if (i + 1 >= text.length) throw new Error('the command ends with a backslash');
      word += text[++i];
    } else if (SHELL_SYNTAX.has(char)) {
      throw new Error(
        `the command uses the shell syntax "${char}"; give one command whose arguments reach ` +
          'Playwright, such as `npx playwright test --project=chromium`'
      );
    } else {
      word += char;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const matches = (arg, flag) => arg === flag || arg.startsWith(`${flag}=`);

/** Options the Action owns or that select tests from state outside the command line. */
const REFUSED = [
  ['--shard', 'the Action owns sharding and adds --shard itself'],
  ['--workers', 'set the workers input, which the plan packs for and the Action passes on'],
  ['-j', 'set the workers input, which the plan packs for and the Action passes on'],
  ['--last-failed', 'it selects tests from the state of an earlier run, which differs per shard'],
  ['--only-changed', 'it selects tests from the state of the working tree'],
  ['--list', 'a list-only run executes nothing'],
  ['--', 'it hands every later argument to the tests, after which the Action cannot add its own'],
];

/** Throws for an option of `REFUSED` in the command's arguments. */
function assertSupported(argv) {
  for (const arg of argv) {
    for (const [flag, reason] of REFUSED) {
      if (
        flag === '--' ? arg === '--' : matches(arg, flag) || (flag === '-j' && /^-j\d+$/.test(arg))
      ) {
        throw new Error(`the command may not contain ${flag}: ${reason}`);
      }
    }
  }
}

/**
 * Removes every `--add-reporter` from the command and returns `{ argv, reporters }`, the values in
 * order. Playwright keeps only the last `--add-reporter`, so the Action folds the user's values and
 * its own into one.
 */
function takeAddReporters(argv) {
  const out = [];
  const reporters = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--add-reporter') {
      if (i + 1 >= argv.length) throw new Error('--add-reporter in the command has no value');
      reporters.push(argv[++i]);
    } else if (arg.startsWith('--add-reporter=')) {
      reporters.push(arg.slice('--add-reporter='.length));
    } else {
      out.push(arg);
    }
  }
  return { argv: out, reporters: reporters.flatMap((value) => value.split(',')).filter(Boolean) };
}

/**
 * The words of one shard's run: the command, `--shard`, `--workers` when set, and one
 * `--add-reporter` that holds the user's added reporters followed by `reporter` (none when null).
 */
function shardArgv(command, { shard, total, workers = null, reporter = null }) {
  const parsed = parseCommand(command);
  assertSupported(parsed);
  const { argv, reporters } = takeAddReporters(parsed);
  const added = reporter ? [...reporters, reporter] : reporters;
  return [
    ...argv,
    `--shard=${shard}/${total}`,
    ...(workers ? [`--workers=${workers}`] : []),
    ...(added.length ? [`--add-reporter=${added.join(',')}`] : []),
  ];
}

module.exports = { assertSupported, parseCommand, shardArgv, takeAddReporters };
