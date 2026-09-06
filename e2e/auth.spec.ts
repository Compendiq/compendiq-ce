import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, registerUser, uniqueUsername } from './helpers/auth';

test.describe('Authentication flow', () => {
  test('register a new user, access protected route, then logout', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /Create one/i }).click();
    await page.getByLabel('Username', { exact: true }).fill(uniqueUsername('e2e_auth'));
    await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: /^Create account$/i }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\//);
    await page.getByRole('button', { name: /e2e_auth_.* menu/ }).click();
    await page.getByRole('menuitem', { name: /log out|sign out/i }).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login with existing user and access protected route', async ({ page }) => {
    const session = await registerUser(page.request, uniqueUsername('e2e_login'));
    // A refresh cookie is the session: clearing localStorage alone is not logout.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Username', { exact: true }).fill(session.username);
    await page.locator('input[type="password"]').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: /^Sign in$/i }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\//);
  });

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
  });

  test('authenticated user stays logged in after page reload', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /Create one/i }).click();
    await page.getByLabel('Username', { exact: true }).fill(uniqueUsername('e2e_refresh'));
    await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: /^Create account$/i }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await page.reload();
    await expect(page.getByRole('button', { name: /e2e_refresh_.* menu/ })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});
