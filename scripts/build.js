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

/**
 * Toolkit dependencies that still call the deprecated `new Buffer()`, which prints a DEP0005
 * warning in the user's log: unzip-stream and its binary and buffers when an artifact downloads,
 * tunnel behind a proxy. No release of them or of @actions/artifact drops it, so the build swaps
 * each call for `Buffer.alloc` (a size) or `Buffer.from` (anything else), what Node documents as
 * the replacement. A listed file with no call left fails the build, so an upgrade that fixes it
 * removes the patch.
 */
const LEGACY_BUFFER = [
  'node_modules/binary/index.js',
  'node_modules/buffers/index.js',
  'node_modules/tunnel/lib/tunnel.js',
  'node_modules/unzip-stream/lib/matcher-stream.js',
  'node_modules/unzip-stream/lib/unzip-stream.js',
];
const LEGACY_SHIM =
  'function __pspBuffer(value, encodingOrOffset, length) {\n' +
  "  return typeof value === 'number' ? Buffer.alloc(value) : Buffer.from(value, encodingOrOffset, length);\n" +
  '}\n';

const legacyBuffer = {
  name: 'legacy-buffer',
  setup(build) {
    const files = new Set(LEGACY_BUFFER.map((file) => path.join(ROOT, file)));
    const seen = new Set();
    build.onLoad({ filter: /\.js$/ }, (args) => {
      if (!files.has(args.path)) return undefined;
      seen.add(args.path);
      const source = fs.readFileSync(args.path, 'utf8');
      const patched = source.replace(/\bnew Buffer\(/g, '__pspBuffer(');
      if (patched === source) {
        throw new Error(
          `${path.relative(ROOT, args.path)} no longer calls new Buffer(); drop it from LEGACY_BUFFER`
        );
      }
      return { contents: `${LEGACY_SHIM}${patched}`, loader: 'js' };
    });
    build.onEnd(() => {
      for (const file of files) {
        if (!seen.has(file))
          throw new Error(
            `${path.relative(ROOT, file)} is not in the bundle; drop it from LEGACY_BUFFER`
          );
      }
    });
  },
};

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
    plugins: [legacyBuffer],
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
