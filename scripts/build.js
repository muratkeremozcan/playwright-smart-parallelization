'use strict';

/**
 * Builds `dist/`: `index.js`, the Action's code with the toolkit bundled in, so a user installs
 * nothing; `main.js` and `post.js`, the entries `action.yml` names (`finish/main.js` runs the same
 * bundle); and `reporter.js`, the reporter `$PSP_ARGS` adds to the user's command, which runs in the
 * user's own Node and Playwright. `npm test` fails when the committed `dist/` differs from a fresh
 * build (tests/dist.test.js). `node scripts/build.js` writes it; `--out <dir>` writes elsewhere.
 */

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

const ENTRY = (step) =>
  `'use strict';\n\n// The ${step} step of the Action; scripts/build.js writes this file.\nrequire('./index.js').run('${step}');\n`;

async function build(out = path.join(ROOT, 'dist')) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    legalComments: 'none',
    logLevel: 'warning',
    // The toolkit ships ES modules only.
    conditions: ['import'],
  };
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'src', 'index.js')],
    outfile: path.join(out, 'index.js'),
    target: 'node24',
    minify: true,
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'reporter', 'reporter.js')],
    outfile: path.join(out, 'reporter.js'),
    // The user's Node, which Playwright 1.63 lets be 20.
    target: 'node20',
  });
  for (const step of ['main', 'post']) {
    fs.writeFileSync(path.join(out, `${step}.js`), ENTRY(step));
  }
  return out;
}

if (require.main === module) {
  const at = process.argv.indexOf('--out');
  build(at === -1 ? undefined : path.resolve(process.argv[at + 1])).catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { build };
