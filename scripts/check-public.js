'use strict';

/**
 * Public-repo hygiene gate. This repository is public, so no tracked or untracked-but-not-ignored
 * file may carry a private home-directory path or a credential-shaped token. Findings print as
 * `file:line: rule` and never echo the matched text, so a leaked secret is not copied into CI logs.
 *
 * Runner paths (`/home/runner`, `/Users/runner`) are public GitHub-hosted runner locations.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RULES = [
  { name: 'private macOS home path', pattern: /\/Users\/(?!runner\b)[^/\s'"]+/ },
  { name: 'private Linux home path', pattern: /\/home\/(?!runner\b)[^/\s'"]+/ },
  { name: 'private Windows home path', pattern: /[A-Za-z]:\\Users\\[^\\\s'"]+/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Returns `[{ file, line, rule }]` for every rule a line of `text` trips. */
function scanText(text, file) {
  const findings = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(lineText)) {
        findings.push({ file, line: index + 1, rule: rule.name });
      }
    }
  });
  return findings;
}

function listFiles(cwd) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return [...new Set(out.split('\0').filter(Boolean))];
}

function scanFiles(files, cwd) {
  const findings = [];
  for (const file of files) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) continue;
    findings.push(...scanText(buffer.toString('utf8'), file));
  }
  return findings;
}

function main(cwd = process.cwd()) {
  const files = listFiles(cwd);
  const findings = scanFiles(files, cwd);
  for (const { file, line, rule } of findings) {
    process.stderr.write(`${file}:${line}: ${rule}\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(`check:public found ${findings.length} finding(s) in a public repo.\n`);
    return 1;
  }
  process.stdout.write(`check:public scanned ${files.length} files, no findings.\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { RULES, listFiles, main, scanFiles, scanText };
