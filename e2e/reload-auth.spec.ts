import { test, expect } from '@playwright/test';

/**
 * E2E: Refresh/reload session retention test
 *
 * Verifies that a logged-in user retains their session across browser page reloads/refreshes.
 */

test.describe('Session refresh retention', () => {
  test('user logs in via UI form and stays logged in after page reload/refresh', async ({ page }) => {
    const testUser = `ui_reload_user_${Date.now()}`;
    const testPass = 'TestPassword123!';

    // 1. Register user via API
    const regRes = await page.request.post('/api/auth/register', {
      data: { username: testUser, password: testPass },
    });
    expect(regRes.ok()).toBe(true);

    // The refresh cookie is the session; localStorage alone cannot log out.
    await page.context().clearCookies();
    await page.goto('/login');

    // 2. Fill login form
    await expect(page.getByText('Sign in to Compendiq')).toBeVisible({ timeout: 10_000 });
    await page.getByLabel('Username').fill(testUser);
    await page.locator('input[type="password"]').first().fill(testPass);
    await page.getByRole('button', { name: /Sign in/i }).click();

    // 3. Verify successful login redirect to /
    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

    // Observe the app's own refresh; a manual second POST races rotation.
    const refreshed = page.waitForResponse((res) =>
      res.url().endsWith('/api/auth/refresh') && res.request().method() === 'POST',
    );
    await page.reload();
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByRole('button', { name: `${testUser} menu` })).toBeVisible();
    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  });
});
