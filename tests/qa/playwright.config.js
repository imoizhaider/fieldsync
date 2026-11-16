import { defineConfig } from '@playwright/test';

// QA suite. Runs against the deployed app by default; set BASE_URL for localhost.
export default defineConfig({
  testDir: './specs',
  outputDir: '../../artifacts/qa/_pw',
  globalSetup: './lib/global-setup.js',
  fullyParallel: false,
  workers: 1,
  retries: 2, // a failure is rerun twice: 3 of 3 = FAIL, mixed = FLAKY
  timeout: 200_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: '../../artifacts/qa/_pw-results.json' }]],
  use: { browserName: 'chromium', serviceWorkers: 'allow', trace: 'off', actionTimeout: 20_000, navigationTimeout: 45_000, viewport: { width: 390, height: 844 } },
});
