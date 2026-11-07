import { defineConfig, devices } from '@playwright/test';

const rawPort = 4191;
const webPort = 4192;
const relayPort = 4193;
const pagesPort = 4194;
const rawOnly = process.env.E2E_RAW_ONLY === '1';
const productionOnly = process.env.E2E_PRODUCTION === '1';

const rawServer = {
  command: 'node apps/web/e2e/raw/server.mjs',
  url: `http://127.0.0.1:${rawPort}/stage.html`,
  reuseExistingServer: true,
  env: { RAW_PORT: String(rawPort) },
};

const webServer = {
  command: 'npx vite --config e2e/vite.e2e.config.ts',
  cwd: 'apps/web',
  url: `http://127.0.0.1:${webPort}/`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: { VITE_RELAY_URL: `http://127.0.0.1:${relayPort}` },
};

const pagesServer = {
  command: 'node apps/web/e2e/production/serve.mjs',
  url: `http://127.0.0.1:${pagesPort}/AfterLink/`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: { PAGES_PORT: String(pagesPort) },
};

export default defineConfig({
  testDir: 'apps/web/e2e',
  outputDir: 'test-results/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'raw', testMatch: 'raw/**/*.spec.ts', use: { baseURL: `http://127.0.0.1:${rawPort}` } },
    {
      name: 'raw-new-headless',
      testMatch: 'raw/**/*.spec.ts',
      use: { baseURL: `http://127.0.0.1:${rawPort}`, channel: 'chromium' },
    },
    { name: 'lab', testMatch: 'lab/**/*.spec.ts', use: { baseURL: `http://127.0.0.1:${webPort}` } },
    { name: 'story', testMatch: 'story/**/*.spec.ts', use: { baseURL: `http://127.0.0.1:${webPort}` } },
    { name: 'relay', testMatch: 'relay/**/*.spec.ts', use: { baseURL: `http://127.0.0.1:${webPort}` } },
    { name: 'production', testMatch: 'production/**/*.spec.ts', use: { baseURL: `http://127.0.0.1:${pagesPort}/AfterLink/` } },
  ],
  webServer: productionOnly ? [pagesServer] : rawOnly ? [rawServer] : [rawServer, webServer],
});
