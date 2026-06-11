import { test, expect } from '@playwright/test';

/**
 * E2E: Confluence connection and first sync
 *
 * Requires a real Confluence Data Center instance. Skipped in CI
 * unless E2E_CONFLUENCE_URL and E2E_CONFLUENCE_PAT are set.
 */

const CONFLUENCE_URL = process.env.E2E_CONFLUENCE_URL;
const CONFLUENCE_PAT = process.env.E2E_CONFLUENCE_PAT;

const TEST_USER = `e2e_confluence_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Confluence sync flow', () => {
  test.skip(
    !CONFLUENCE_URL || !CONFLUENCE_PAT,
    'Requires Confluence instance (set E2E_CONFLUENCE_URL and E2E_CONFLUENCE_PAT)',
  );

  let authToken: string;
  let authUser: { id: string; username: string; role: string };

  test.beforeEach(async ({ page }) => {
    // Register a fresh user via API
    const registerRes = await page.request.post('/api/auth/register', {
      data: {
        username: TEST_USER + Math.random().toString(36).slice(2, 6),
        password: TEST_PASS,
      },
    });

    if (!registerRes.ok()) {
      test.skip();
      return;
    }

    const data = await registerRes.json();
    authToken = data.accessToken;
    authUser = data.user;

    // Set auth in localStorage (Zustand persist format)
    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user }) => {
        const authState = {
          state: { accessToken, user, isAuthenticated: true },
          version: 0,
        };
        localStorage.setItem('compendiq-auth', JSON.stringify(authState));
      },
      { accessToken: authToken, user: authUser },
    );
  });

  test('connect to Confluence and trigger first sync', async ({ page }) => {
    // Navigate to settings page
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // The Confluence tab should be active by default
    await expect(
      page.getByText('Confluence').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for settings form to load
    await page.waitForLoadState('networkidle');

    // Fill in the Confluence URL
    const urlInput = page
      .getByPlaceholder('https://confluence.company.com')
      .or(page.getByPlaceholder(/confluence/i))
      .or(page.locator('input[type="url"]'));

    await expect(urlInput.first()).toBeVisible({ timeout: 10_000 });
    await urlInput.first().fill(CONFLUENCE_URL!);

    // Fill in the Personal Access Token
    const patInput = page
      .getByPlaceholder('Enter PAT')
      .or(page.getByPlaceholder(/PAT|token/i))
      .or(page.locator('input[type="password"]'));

    await expect(patInput.first()).toBeVisible({ timeout: 5_000 });
    await patInput.first().fill(CONFLUENCE_PAT!);

    // Click "Test Connection" and verify success
    const testBtn = page
      .getByRole('button', { name: /Test Connection/i })
      .or(page.getByText('Test Connection'));

    await expect(testBtn.first()).toBeVisible({ timeout: 5_000 });
    await testBtn.first().click();

    // Wait for the connection test result box. Located via data-testid +
    // data-state (pinned by ConfluenceTab.test.tsx) rather than Tailwind
    // utility classes, so a styling refactor can't silently hollow out
    // this assertion.
    const resultIndicator = page.getByTestId('confluence-test-result');
    await expect(resultIndicator).toBeVisible({ timeout: 15_000 });

    // Verify the test succeeded.
    await expect(resultIndicator).toHaveAttribute('data-state', 'success', {
      timeout: 5_000,
    });

    // Save the Confluence settings
    const saveBtn = page
      .getByRole('button', { name: /^Save$/i })
      .or(page.locator('button[type="submit"]'));

    await expect(saveBtn.first()).toBeVisible({ timeout: 5_000 });
    await saveBtn.first().click();

    // Verify save confirmation (toast or inline message)
    await expect(
      page.getByText(/saved|success/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Go to Knowledge → Spaces & Sync and discover spaces from Confluence
    await page.goto('/settings/knowledge/spaces');
    await page.getByRole('button', { name: /Fetch Spaces/i }).click();

    // At least one remote space appears as a selectable row ("Select <name>")
    const selectSpaceBtn = page.getByRole('button', { name: /^Select / });
    await expect(selectSpaceBtn.first()).toBeVisible({ timeout: 15_000 });

    // Select the first discovered space and persist the selection
    await selectSpaceBtn.first().click();
    await page.getByRole('button', { name: /Save Selection/i }).click();

    // Trigger the first sync for the selected space
    const syncSelected = page.getByRole('button', { name: /Sync Selected/i });
    await expect(syncSelected).toBeEnabled({ timeout: 10_000 });
    await syncSelected.click();

    // Sync completion is reflected by the space row gaining a "Synced: <date>"
    // stamp (sync of the small fixture space takes seconds)
    await expect(
      page.getByText(/Synced: \d/).first(),
    ).toBeVisible({ timeout: 60_000 });

    // End-to-end proof: synced Confluence pages are served to the user
    const pages = await page.request.get('/api/pages?source=confluence', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(pages.ok()).toBe(true);
    const body = await pages.json();
    const items = body.items ?? body.pages ?? [];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  test('saves Confluence URL and displays it after page reload', async ({ page }) => {
    // Navigate to settings
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // Wait for settings form to load
    await page.waitForLoadState('networkidle');

    // Fill in the Confluence URL
    const urlInput = page
      .getByPlaceholder('https://confluence.company.com')
      .or(page.getByPlaceholder(/confluence/i))
      .or(page.locator('input[type="url"]'));

    await expect(urlInput.first()).toBeVisible({ timeout: 10_000 });
    await urlInput.first().fill(CONFLUENCE_URL!);

    // Save settings
    const saveBtn = page
      .getByRole('button', { name: /^Save$/i })
      .or(page.locator('button[type="submit"]'));

    await saveBtn.first().click();

    // Wait for save confirmation
    await expect(
      page.getByText(/saved|success/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Reload the page and verify the URL persisted
    await page.reload();
    await page.waitForLoadState('networkidle');

    const reloadedUrlInput = page
      .getByPlaceholder('https://confluence.company.com')
      .or(page.getByPlaceholder(/confluence/i))
      .or(page.locator('input[type="url"]'));

    await expect(reloadedUrlInput.first()).toBeVisible({ timeout: 10_000 });
    await expect(reloadedUrlInput.first()).toHaveValue(CONFLUENCE_URL!);
  });
});
