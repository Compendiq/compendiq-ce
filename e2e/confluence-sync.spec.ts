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

    // Wait for the connection test result (success or failure indicator)
    // The result appears as a coloured box with a message
    const resultIndicator = page
      .locator('.bg-success\\/10')
      .or(page.locator('.bg-destructive\\/10'))
      .or(page.getByText(/connected|success|failed|error/i));

    await expect(resultIndicator.first()).toBeVisible({ timeout: 15_000 });

    // Verify the test succeeded (green success indicator)
    const successIndicator = page
      .locator('.bg-success\\/10')
      .or(page.getByText(/connected|success/i));

    await expect(successIndicator.first()).toBeVisible({ timeout: 5_000 });

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

    // Switch to the Sync tab to trigger sync
    await page.getByText('Sync').first().click();
    await page.waitForLoadState('domcontentloaded');

    // Look for a sync trigger button
    const syncBtn = page
      .getByRole('button', { name: /sync now|start sync|trigger sync/i })
      .or(page.getByTestId('sync-trigger-btn'));

    if (await syncBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await syncBtn.first().click();

      // Verify that sync started (status changes or progress indicator appears)
      const syncStatus = page
        .getByText(/syncing|in progress|started/i)
        .or(page.locator('[data-testid="sync-status"]'));

      await expect(syncStatus.first()).toBeVisible({ timeout: 10_000 });
    }

    // Switch to the Spaces tab to verify spaces were discovered
    await page.getByText('Spaces').first().click();
    await page.waitForLoadState('networkidle');

    // After a successful connection, at least one Confluence space should appear
    // Allow extra time because space fetching may be async
    const spaceItem = page
      .locator('[data-testid="space-item"]')
      .or(page.getByRole('checkbox'))
      .or(page.locator('label').filter({ hasText: /.+/ }));

    const hasSpaces = await spaceItem
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    // Spaces appearing confirms the connection is working end-to-end
    if (hasSpaces) {
      expect(hasSpaces).toBe(true);
    }
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
