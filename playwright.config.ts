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
      testIgnore: /collab-editing/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Isolated: this spec PUTs collabEditingEnabled. workers:1 + not
      // fullyParallel so it cannot race the rest of the suite, which stays
      // flag-off because chromium ignores the file.
      name: 'collab',
      testMatch: /collab-editing/,
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
