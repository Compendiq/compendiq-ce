import { test, expect } from '@playwright/test';

/**
 * E2E: Authentication flow
 *
 * Tests register -> login -> access protected route -> logout -> session retention on refresh.
 * Uses a unique username per run to avoid conflicts.
 */

const TEST_USER = `e2e_auth_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Authentication flow', () => {
  test('register a new user, access protected route, then logout', async ({
    page,
  }) => {
    // 1. Navigate to the login page
    await page.goto('/login');

    // The login page should render
    await expect(
      page.getByText(/Sign in to Compendiq|Create your account/),
    ).toBeVisible({ timeout: 10_000 });

    // 2. Switch to registration mode if on sign in
    const createOneLink = page.getByRole('button', { name: /Create one/i });
    if (await createOneLink.isVisible().catch(() => false)) {
      await createOneLink.click();
    }

    // Should now show "Create your account"
    await expect(page.getByText('Create your account')).toBeVisible();

    // 3. Fill registration form
    await page.getByLabel('Username').fill(TEST_USER);
    await page.locator('input[type="password"]').first().fill(TEST_PASS);

    // 4. Submit registration
    await page.getByRole('button', { name: /Create Account/i }).click();

    // 5. Should redirect to the main app (pages view at /)
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    // Verify we can see the main app layout
    await expect(
      page.locator('[data-testid="app-layout"]').or(page.locator('nav')).or(page.locator('aside')),
    ).toBeVisible({ timeout: 10_000 });

    // 6. Navigate to a protected route (settings)
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    // Should see the settings page content
    await expect(
      page.getByText('Confluence').or(page.getByText('Settings')),
    ).toBeVisible({ timeout: 10_000 });

    // 7. Logout via the user menu
    const userMenuTrigger = page
      .getByTestId('user-menu-trigger')
      .or(page.getByRole('button', { name: new RegExp(TEST_USER, 'i') }))
      .or(page.locator('[data-testid="sidebar-user-menu"]'));

    if (await userMenuTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await userMenuTrigger.click();

      const logoutBtn = page.getByRole('menuitem', { name: /log\s?out|sign\s?out/i })
        .or(page.getByText(/log\s?out|sign\s?out/i));

      if (await logoutBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await logoutBtn.click();
        await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
      }
    } else {
      await page.evaluate(() => {
        localStorage.clear();
      });
      await page.goto('/login');
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    }
  });

  test('login with existing user and access protected route', async ({
    page,
  }) => {
    const loginUser = `e2e_login_${Date.now()}`;

    await page.goto('/login');
    await expect(page.getByText(/Sign in to Compendiq|Create your account/)).toBeVisible({
      timeout: 10_000,
    });

    // Register first
    const createOneLink = page.getByRole('button', { name: /Create one/i });
    if (await createOneLink.isVisible().catch(() => false)) {
      await createOneLink.click();
    }

    await page.getByLabel('Username').fill(loginUser);
    await page.locator('input[type="password"]').first().fill(TEST_PASS);
    await page.getByRole('button', { name: /Create Account/i }).click();

    // Wait for redirect
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    // Logout by clearing auth state
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

    // Now test login
    await expect(page.getByText('Sign in to Compendiq')).toBeVisible();

    await page.getByLabel('Username').fill(loginUser);
    await page.locator('input[type="password"]').first().fill(TEST_PASS);
    await page.getByRole('button', { name: /Sign In/i }).click();

    // Should redirect to the main app
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.clear();
    });

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('authenticated user stays logged in after page reload/refresh', async ({
    page,
  }) => {
    const refreshUser = `e2e_refresh_${Date.now()}`;

    await page.goto('/login');
    const createOneLink = page.getByRole('button', { name: /Create one/i });
    if (await createOneLink.isVisible().catch(() => false)) {
      await createOneLink.click();
    }

    await page.getByLabel('Username').fill(refreshUser);
    await page.locator('input[type="password"]').first().fill(TEST_PASS);
    await page.getByRole('button', { name: /Create Account/i }).click();

    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    // Refresh the page
    await page.reload();

    // Verify user stays logged in on / (not redirected to /login)
    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(
      page.locator('[data-testid="app-layout"]').or(page.locator('nav')).or(page.locator('aside')),
    ).toBeVisible({ timeout: 10_000 });
  });
});
