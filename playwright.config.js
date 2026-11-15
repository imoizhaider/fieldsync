import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4173);

// The app is served under /fieldsync/ so every run also proves sub-path hosting.
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'artifacts/test-results',
  globalSetup: './tests/e2e/global-setup.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'artifacts/e2e-results.json' }]],
  use: {
    browserName: 'chromium',
    baseURL: `http://localhost:${PORT}/fieldsync/`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `http://localhost:${PORT}/fieldsync/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
