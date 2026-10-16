'use strict';

/**
 * The rejected form of shape B, kept as evidence: a wrapper config the Action would generate in a
 * folder of its own, which loads
 * the user's config and appends a reporter, so the user's config stays as it is. Playwright
 * resolves every relative path of a config against the folder of the config file it loads, which
 * is the wrapper's folder, so the `resolved` wrapper first resolves the paths of the user config
 * against the user's folder:
 *
 *   testDir, outputDir, snapshotDir, globalSetup, globalTeardown, tsconfig and the same fields of
 *   each project; the `cwd` of each web server; a reporter given by path or package name, and
 *   the `outputFile`, `outputFolder` and `outputDir` options of a reporter.
 *
 * Playwright's own defaults that depend on the config folder are made explicit: `testDir` (the
 * config folder), `outputDir` (`test-results` next to the nearest `package.json`) and the default
 * reporter. The `naive` wrapper only appends the reporter, which is the control.
 *
 * `writeWrapper` returns the path of the generated `.js` file. The `sb.wrapper-*` rows show the
 * configs whose meaning this rewrite changes; the Action adds its reporter with `--add-reporter`
 * and leaves the user's config alone (`lib/action-reporter.mjs`).
 */

const fs = require('node:fs');
const path = require('node:path');

/** The source of the code that runs inside the wrapper: it resolves the user config. */
const RESOLVE = String.raw`
const path = require('node:path');
const fs = require('node:fs');

const BUILTIN = new Set(['list', 'line', 'dot', 'json', 'junit', 'html', 'blob', 'github', 'null', 'markdown']);
const OUTPUT_KEYS = ['outputFile', 'outputFolder', 'outputDir'];

function packageDir(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, 'package.json'))) return at;
    if (path.dirname(at) === at) return dir;
  }
}

function resolveConfig(user, dir, appended) {
  const abs = (p) => (typeof p === 'string' && p !== '' ? path.resolve(dir, p) : p);
  const scripts = (s) => (Array.isArray(s) ? s.map(abs) : abs(s));
  const reporterId = (id) =>
    BUILTIN.has(id) ? id : id.startsWith('.') || path.isAbsolute(id) ? path.resolve(dir, id) : require.resolve(id, { paths: [dir] });
  const reporters = (r) => {
    const list = r === undefined ? [[process.env.CI ? 'dot' : 'list']] : typeof r === 'string' ? [[r]] : r;
    return list.map((entry) => {
      const [id, options] = typeof entry === 'string' ? [entry] : entry;
      if (!options || typeof options !== 'object') return options === undefined ? [reporterId(id)] : [reporterId(id), options];
      const resolved = { ...options };
      for (const key of OUTPUT_KEYS) if (typeof resolved[key] === 'string') resolved[key] = abs(resolved[key]);
      return [reporterId(id), resolved];
    });
  };
  const own = (object, keys) => {
    const out = { ...object };
    for (const key of keys) if (out[key] !== undefined) out[key] = key.startsWith('global') ? scripts(out[key]) : abs(out[key]);
    return out;
  };
  const config = own(user, ['testDir', 'outputDir', 'snapshotDir', 'globalSetup', 'globalTeardown', 'tsconfig']);
  if (config.testDir === undefined) config.testDir = dir;
  if (config.outputDir === undefined) config.outputDir = path.join(packageDir(dir), 'test-results');
  if (Array.isArray(user.projects)) config.projects = user.projects.map((p) => own(p, ['testDir', 'outputDir', 'snapshotDir']));
  if (user.webServer) {
    const servers = (Array.isArray(user.webServer) ? user.webServer : [user.webServer]).map((s) => ({ ...s, cwd: abs(s.cwd || '.') }));
    config.webServer = Array.isArray(user.webServer) ? servers : servers[0];
  }
  config.reporter = [...reporters(user.reporter), ...appended];
  return config;
}
`;

/**
 * Writes a wrapper for the config at `userConfig` into `dir` and returns its path. `reporter` is
 * `[file, options]`, the reporter the Action appends. `mode` is `resolved` or `naive`.
 */
function writeWrapper({ dir, userConfig, reporter, mode = 'resolved' }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wrapper-${mode}.config.js`);
  const load = `const loaded = require(${JSON.stringify(userConfig)});\nconst user = loaded && loaded.__esModule ? loaded.default : (loaded.default ?? loaded);\n`;
  const body =
    mode === 'naive'
      ? `const toList = (r) => (r === undefined ? [] : typeof r === 'string' ? [[r]] : r);\nmodule.exports = { ...user, reporter: [...toList(user.reporter), ${JSON.stringify(reporter)}] };\n`
      : `${RESOLVE}\nmodule.exports = resolveConfig(user, ${JSON.stringify(path.dirname(userConfig))}, [${JSON.stringify(reporter)}]);\n`;
  fs.writeFileSync(file, `'use strict';\n\n${load}${body}`);
  return file;
}

module.exports = { writeWrapper };
