import { defineConfig, devices } from '@playwright/test';
import { ciEnvironment } from './e2e/helpers/ci-setup';

const ciSuite = process.env.E2E_CI === '1';
if (ciSuite) ciEnvironment();
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8081';
const backendPort = process.env.BACKEND_PORT || '3051';
// These require operator-owned infrastructure, not the disposable CI stack.
// The mocked Confluence flow still runs; collab runs last with the setup admin.
const externalSpecs = ciSuite ? [
  '**/confluence-sync.spec.ts', // Live Confluence URL + PAT.
  '**/llm-providers.spec.ts', // Live Ollama + first-user-admin fixture.
  '**/think-toggle.spec.ts', // Special LLM request-log harness + first-user admin.
] : [];

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/helpers/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Specs mutate instance settings; one worker isolates those writes. Provisioning
  // also raises auth limits on the disposable instance (serial is still >5/min).
  workers: process.env.CI || ciSuite ? 1 : undefined,
  reporter: ciSuite
    ? [['line'], ['html', { open: 'never' }], ['./e2e/helpers/ci-reporter.ts']]
    : 'html',
  globalSetup: ciSuite ? './e2e/helpers/ci-setup.ts' : undefined,
  webServer: ciSuite ? [
    {
      command: 'npm run start -w backend',
      url: `http://127.0.0.1:${backendPort}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `npm exec -w frontend -- vite preview --host 127.0.0.1 --port ${new URL(baseURL).port || '8081'} --strictPort`,
      url: baseURL,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ] : undefined,
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/helpers/**', /collab-editing/, ...externalSpecs],
      // Keep the native user agent: a Windows device UA on macOS makes the
      // app advertise Ctrl while Playwright's native modifier sends Meta.
      use: { ...devices['Desktop Chrome'], userAgent: undefined },
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
      use: { ...devices['Desktop Chrome'], userAgent: undefined },
    },
  ],
});
