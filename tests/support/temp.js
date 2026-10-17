'use strict';

/**
 * Loaded with `--require` by `npm test`: every test process, and every Playwright or Node process
 * it starts, makes its temporary folders under one folder of its own, removed when the process
 * exits. The tests create thousands of workspaces, runner temps and records, and without this
 * each run leaves them in the system temp folder.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-test-'));
process.env.TMPDIR = root;
process.env.TMP = root;
process.env.TEMP = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
