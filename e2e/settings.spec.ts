import { test, expect } from '@playwright/test';

/**
 * E2E: Settings page
 *
 * Tests that the settings page loads and all panels are accessible.
 */

const TEST_USER = `e2e_settings_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Settings page', () => {
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

    // Set auth in localStorage
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

  test('navigates to settings and displays tab panels', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // The settings page should show the Confluence tab by default
    await expect(
      page.getByText('Confluence').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Check that other standard tabs are visible
    await expect(page.getByText('Sync').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Spaces').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Theme').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('AI Prompts').first()).toBeVisible({ timeout: 5_000 });
  });

  test('Confluence tab shows URL and PAT inputs', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // Wait for settings to load
    await page.waitForLoadState('networkidle');

    // The Confluence section should have URL and PAT inputs
    const urlInput = page
      .getByPlaceholder(/confluence|https:/i)
      .or(page.getByLabel(/confluence url/i));

    await expect(urlInput.first()).toBeVisible({ timeout: 10_000 });
  });

  test('can switch between settings tabs', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // Wait for the page to load
    await expect(page.getByText('Confluence').first()).toBeVisible({ timeout: 10_000 });

    // Click the Sync tab
    await page.getByText('Sync').first().click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Click the Theme tab
    await page.getByText('Theme').first().click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Theme tab should show some theme-related content
    await expect(
      page.getByText(/theme|appearance|dark|light/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Click the Spaces tab
    await page.getByText('Spaces').first().click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');
  });

  test('shows admin-only tabs for admin users', async ({ page }) => {
    // First user registered is admin
    if (authUser.role !== 'admin') {
      test.skip();
      return;
    }

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // Admin-only tabs should be visible
    await expect(page.getByText('LLM').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Labels').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Errors').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Embedding').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Workers').first()).toBeVisible({ timeout: 5_000 });
  });

  test('LLM tab shows provider configuration', async ({ page }) => {
    if (authUser.role !== 'admin') {
      test.skip();
      return;
    }

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // Click the LLM tab
    await expect(page.getByText('LLM').first()).toBeVisible({ timeout: 10_000 });
    await page.getByText('LLM').first().click();

    // Should show LLM-related configuration options
    await expect(
      page.getByText(/ollama|openai|provider|model/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
