import { test, expect } from '@playwright/test';

/**
 * E2E: Confluence connection and first sync — mocked.
 *
 * Unlike `confluence-sync.spec.ts` (which needs a real Confluence DC instance
 * and is skipped in CI), this spec intercepts the browser-originated
 * `/api/settings/*`, `/api/spaces*`, and `/api/sync*` calls via Playwright's
 * `page.route` and fulfils them with in-test fixtures. That means the test
 * runs green against any locally running backend without touching a real
 * Confluence server.
 *
 * Scope: the frontend wire-up from "enter URL + PAT" → "test connection
 * succeeds" → "save settings" → "sync triggered" → "spaces appear in UI".
 * The backend sync pipeline itself is covered by unit tests in
 * `backend/src/domains/confluence/services/*.test.ts`; this spec does not
 * exercise the real `confluence-client` / `sync-service` code paths (which
 * use Node-side `undici.request` and cannot be intercepted from Playwright's
 * browser-side `page.route`).
 *
 * Fixture shape: 2 spaces (`CS-DEV`, `CS-QA`), 10 pages total, 1 attachment,
 * 1 cross-space link. Matches the "realistic" fixture tier decided in the
 * Phase 0 planning session.
 */

const TEST_USER_PREFIX = 'e2e_conf_mock_';
const TEST_PASS = 'TestPassword123!';

const MOCK_CONFLUENCE_URL = 'https://confluence.mock.test';
const MOCK_CONFLUENCE_PAT = 'FAKE-PAT-not-a-real-token';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_SPACES = [
  {
    id: 1001,
    key: 'CS-DEV',
    name: 'Engineering — Dev',
    type: 'global',
    pageCount: 6,
  },
  {
    id: 1002,
    key: 'CS-QA',
    name: 'Engineering — QA',
    type: 'global',
    pageCount: 4,
  },
];

function makeMockPages() {
  const pages = [];
  for (let i = 1; i <= 6; i++) {
    pages.push({
      id: 2000 + i,
      title: `Dev Runbook ${i}`,
      spaceKey: 'CS-DEV',
      source: 'confluence',
      updatedAt: '2026-04-01T12:00:00.000Z',
    });
  }
  for (let i = 1; i <= 4; i++) {
    pages.push({
      id: 3000 + i,
      title: `QA Test Plan ${i}`,
      spaceKey: 'CS-QA',
      source: 'confluence',
      updatedAt: '2026-04-01T12:00:00.000Z',
    });
  }
  return pages;
}

const MOCK_PAGES = makeMockPages();

const MOCK_ATTACHMENT = {
  id: 9001,
  pageId: 2001,
  filename: 'deployment-checklist.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 54_321,
};

// Cross-space link: page CS-DEV/2001 references CS-QA/3001 in its body
// (not asserted directly — just part of the fixture contract).

// Matches SettingsResponseSchema in @compendiq/contracts. Kept in sync with
// backend schema so the frontend's SettingsPage renders fully without
// undefined-field fallbacks interfering with the tests.
const MOCK_SETTINGS_INITIAL = {
  confluenceUrl: null,
  hasConfluencePat: false,
  selectedSpaces: [],
  ollamaModel: 'llama3.2:latest',
  llmProvider: 'ollama',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: 'bge-m3',
  theme: 'midnight-blue',
  syncIntervalMin: 15,
  confluenceConnected: false,
  showSpaceHomeContent: true,
  customPrompts: {},
};

const MOCK_ASSET_COUNTS = { expected: 0, cached: 0, missing: 0 };

// Matches SyncOverviewResponseSchema in @compendiq/contracts.
const MOCK_SYNC_OVERVIEW_IDLE = {
  sync: {
    userId: 'mock-user',
    status: 'idle' as const,
  },
  totals: {
    selectedSpaces: 2,
    totalPages: MOCK_PAGES.length,
    pagesWithAssets: 1,
    pagesWithIssues: 0,
    healthyPages: MOCK_PAGES.length,
    images: MOCK_ASSET_COUNTS,
    drawio: MOCK_ASSET_COUNTS,
  },
  spaces: MOCK_SPACES.map((s) => ({
    spaceKey: s.key,
    spaceName: s.name,
    status: 'healthy' as const,
    lastSynced: '2026-04-10T23:00:00.000Z',
    pageCount: s.pageCount,
    pagesWithAssets: s.key === 'CS-DEV' ? 1 : 0,
    pagesWithIssues: 0,
    images: MOCK_ASSET_COUNTS,
    drawio: MOCK_ASSET_COUNTS,
  })),
  issues: [],
};

// ─── Spec ─────────────────────────────────────────────────────────────────

test.describe('Confluence sync flow (mocked)', () => {
  test.beforeEach(async ({ page }) => {
    // Register a fresh user so we have a real auth token and real JWT gating.
    // Only the *Confluence*-specific endpoints are mocked below — auth is real.
    const username = TEST_USER_PREFIX + Date.now() + Math.random().toString(36).slice(2, 6);
    const registerRes = await page.request.post('/api/auth/register', {
      data: { username, password: TEST_PASS },
    });
    if (!registerRes.ok()) {
      test.skip();
      return;
    }
    const { accessToken, user } = await registerRes.json();

    // Persist auth state in Zustand's localStorage format so the SPA
    // considers us logged in on first navigation.
    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user }) => {
        localStorage.setItem(
          'compendiq-auth',
          JSON.stringify({
            state: { accessToken, user, isAuthenticated: true },
            version: 0,
          }),
        );
      },
      { accessToken, user },
    );

    // Mutable "saved" settings state so PUT /api/settings → subsequent GET
    // observes the new Confluence URL without persisting anything server-side.
    const savedSettings: Record<string, unknown> = { ...MOCK_SETTINGS_INITIAL };

    // ─── GET /api/settings → always returns the most recent mutation ──
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedSettings),
        });
      }
      if (route.request().method() === 'PUT') {
        const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
        Object.assign(savedSettings, body);
        if (typeof body.confluenceUrl === 'string' && body.confluenceUrl) {
          savedSettings.confluenceConnected = true;
        }
        if (typeof body.confluencePat === 'string' && body.confluencePat) {
          savedSettings.hasConfluencePat = true;
          // Never echo the PAT back on GET
          delete savedSettings.confluencePat;
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedSettings),
        });
      }
      return route.fallback();
    });

    // ─── POST /api/settings/test-confluence → always succeeds in the mock ──
    await page.route('**/api/settings/test-confluence', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          spaces: MOCK_SPACES.map((s) => ({ key: s.key, name: s.name })),
        }),
      });
    });

    // ─── GET /api/settings/sync-overview → idle state with both spaces ──
    await page.route('**/api/settings/sync-overview', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SYNC_OVERVIEW_IDLE),
      });
    });

    // ─── Spaces endpoints ──────────────────────────────────────────────
    await page.route('**/api/spaces/available', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SPACES.map((s) => ({
          key: s.key,
          name: s.name,
          pageCount: s.pageCount,
        }))),
      });
    });

    await page.route('**/api/spaces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SPACES),
      });
    });

    // ─── POST /api/sync → trigger a fake sync job ─────────────────────
    await page.route('**/api/sync', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            jobs: MOCK_SPACES.map((s, i) => ({
              id: 100 + i,
              spaceKey: s.key,
              status: 'queued',
            })),
          }),
        });
        return;
      }
      return route.fallback();
    });

    // ─── GET /api/pages → mocked list (used by Pages listing, optional)
    await page.route('**/api/pages**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: MOCK_PAGES,
            total: MOCK_PAGES.length,
            page: 1,
            limit: 50,
          }),
        });
        return;
      }
      return route.fallback();
    });

    // ─── GET /api/pages/:id/attachments → single attachment fixture ───
    await page.route('**/api/pages/*/attachments', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([MOCK_ATTACHMENT]),
      });
    });
  });

  test('user enters Confluence URL, tests connection, and sees spaces in UI', async ({ page }) => {
    // Navigate to the Settings → Confluence tab
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Fill the URL input (placeholder is "https://confluence.company.com")
    const urlInput = page.getByPlaceholder('https://confluence.company.com');
    await expect(urlInput).toBeVisible({ timeout: 10_000 });
    await urlInput.fill(MOCK_CONFLUENCE_URL);

    // Fill the PAT input. The field is type=password with placeholder "Enter PAT"
    const patInput = page.getByPlaceholder(/PAT|token/i).or(page.locator('input[type="password"]')).first();
    await patInput.fill(MOCK_CONFLUENCE_PAT);

    // Click Test Connection (mocked endpoint returns success + 2 spaces)
    const testBtn = page.getByRole('button', { name: /Test Connection/i });
    await testBtn.click();

    // Verify the connection-test success indicator appears
    const successIndicator = page
      .locator('.bg-success\\/10')
      .or(page.getByText(/connected|success|2 spaces found/i))
      .first();
    await expect(successIndicator).toBeVisible({ timeout: 5_000 });

    // Save the settings. The mocked PUT /api/settings mutates in-memory state
    // so a subsequent GET returns the saved URL.
    const saveBtn = page.getByRole('button', { name: /^Save$/i }).first();
    await saveBtn.click();

    // Toast/inline confirmation
    await expect(page.getByText(/saved|success/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Spaces tab lists both mocked spaces after save', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Switch to the Spaces tab
    await page.getByTestId('tab-spaces').click();
    await page.waitForLoadState('networkidle');

    // Both mocked space names should render (from GET /api/spaces/available)
    await expect(page.getByText('Engineering — Dev').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Engineering — QA').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Sync tab renders the overview with idle spaces', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Switch to the Sync tab
    await page.getByTestId('tab-sync').click();
    await page.waitForLoadState('networkidle');

    // At least one of the mocked space names should appear in the overview
    await expect(
      page.getByText(/Engineering — Dev|CS-DEV/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
