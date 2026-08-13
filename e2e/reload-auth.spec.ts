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

    // Clear auth state to simulate a fresh browser session on the login page
    await page.goto('/login');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/login');

    // 2. Fill login form
    await expect(page.getByText('Sign in to Compendiq')).toBeVisible({ timeout: 10_000 });
    await page.getByLabel('Username').fill(testUser);
    await page.locator('input[type="password"]').first().fill(testPass);
    await page.getByRole('button', { name: /Sign in/i }).click();

    // 3. Verify successful login redirect to /
    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

    // 4. RELOAD / REFRESH the page
    await page.reload();

    // 5. Assert user STAYS logged in on / (not kicked back to /login)
    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

    // 6. Verify silent refresh endpoint returns 200 OK
    const refreshStatus = await page.evaluate(async () => {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      return res.status;
    });
    expect(refreshStatus).toBe(200);
  });
});
