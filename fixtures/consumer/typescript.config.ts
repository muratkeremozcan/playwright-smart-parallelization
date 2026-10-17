import { defineConfig } from '@playwright/test';

// The main config written in TypeScript, which Playwright loads itself.
export default defineConfig({
  testDir: './tests',
  retries: 2,
  reporter: 'list',
  projects: [
    { name: 'setup', testMatch: /global\.setup\.js/, teardown: 'teardown' },
    { name: 'teardown', testMatch: /global\.teardown\.js/ },
    { name: 'chromium', testMatch: /.*\.spec\.js/, dependencies: ['setup'] },
    { name: 'firefox', testMatch: /.*\.spec\.js/, dependencies: ['setup'] },
  ],
});
