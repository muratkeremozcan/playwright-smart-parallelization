'use strict';

/**
 * Playwright reporter, added with `--add-reporter`, that writes the resolved `FullConfig` of a run
 * as JSON to the file named by `PSP_CONFIG_PROBE_OUT`: the root and config file, the global setup
 * and teardown, the reporters with their options, the web servers and every project with its
 * paths and matchers. The shape B rows compare the probe of a user config with the probe of the
 * wrapper the Action generates for it.
 */

const fs = require('node:fs');

const text = (value) =>
  Array.isArray(value) ? value.map(text) : value instanceof RegExp ? String(value) : value;

class ConfigProbe {
  printsToStdio() {
    return false;
  }

  onBegin(config) {
    const probe = {
      rootDir: config.rootDir,
      configFile: config.configFile,
      globalSetup: config.globalSetup,
      globalTeardown: config.globalTeardown,
      fullyParallel: config.fullyParallel,
      // The probe itself is the last reporter: Playwright adds `--add-reporter` reporters last.
      reporter: config.reporter.slice(0, -1).map(([name, options]) => [name, options ?? null]),
      webServer: config.webServer,
      projects: config.projects.map((p) => ({
        name: p.name,
        testDir: p.testDir,
        outputDir: p.outputDir,
        snapshotDir: p.snapshotDir,
        testMatch: text(p.testMatch),
        testIgnore: text(p.testIgnore),
        dependencies: p.dependencies,
        teardown: p.teardown ?? null,
        retries: p.retries,
        repeatEach: p.repeatEach,
      })),
    };
    fs.writeFileSync(process.env.PSP_CONFIG_PROBE_OUT, JSON.stringify(probe));
  }
}

module.exports = ConfigProbe;
