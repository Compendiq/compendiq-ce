import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/helpers/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8081',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/helpers/**', /collab-editing/],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Isolated: this spec PUTs collabEditingEnabled. `dependencies` runs
      // it after chromium so a full `npx playwright test` keeps the flag
      // off during the default suite. workers:1 + not fullyParallel so
      // collab cannot race itself.
      name: 'collab',
      testMatch: /collab-editing/,
      dependencies: ['chromium'],
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
