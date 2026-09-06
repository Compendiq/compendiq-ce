import { test, expect } from '@playwright/test';
import { authenticateContext, loginUser, registerUser, uniqueUsername } from './helpers/auth';

test.describe('Settings page — left-rail navigation', () => {
  test.beforeEach(async ({ context }) => {
    const session = await registerUser(context.request, uniqueUsername('e2e_nav'));
    expect(session.user.role).toBe('user');
    await authenticateContext(context, session);
  });

  test('deep link to appearance lands on the selected panel', async ({ page }) => {
    await page.goto('/settings/personal/theme');
    await expect(page.getByTestId('nav-settings-theme')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('theme-paper')).toBeVisible();
  });

  test('/settings redirects to the first visible panel', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/personal\/confluence$/);
    await expect(page.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
  });

  test('clicking a rail link updates the URL and current-page state', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await expect(page.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('nav-settings-theme').click();
    await expect(page).toHaveURL(/\/settings\/personal\/theme$/);
    await expect(page.getByTestId('nav-settings-theme')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-settings-confluence')).not.toHaveAttribute('aria-current', 'page');
  });

  test('keyboard follows rail order and Enter activates the focused panel', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await page.getByTestId('nav-settings-confluence').focus();
    for (const panel of ['ai-prompts', 'editor', 'theme']) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(`nav-settings-${panel}`)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/personal\/theme$/);
    await expect(page.getByTestId('theme-paper')).toBeVisible();
  });

  test('browser back and forward restore the selected panel', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await page.getByTestId('nav-settings-theme').click();
    await expect(page).toHaveURL(/\/settings\/personal\/theme$/);
    await page.goBack();
    await expect(page.getByTestId('nav-settings-confluence')).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    await expect(page.getByTestId('nav-settings-theme')).toHaveAttribute('aria-current', 'page');
  });

  test('non-admin cannot reach an admin-only panel via direct URL', async ({ page }) => {
    await page.goto('/settings/ai/models');
    await expect(page).toHaveURL(/\/settings\/personal\/confluence$/);
    await expect(page.getByTestId('nav-settings-models')).toHaveCount(0);
    await expect(page.getByLabel('Confluence URL', { exact: true })).toBeVisible();
  });

  test('unknown panel preserves the broken URL and offers a way back', async ({ page }) => {
    await page.goto('/settings/foo/bar');
    await expect(page.getByText("This settings page doesn't exist.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/foo\/bar$/);
    await page.getByRole('link', { name: 'Go to Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/personal\/confluence$/);
  });
});

test.describe('Admin settings navigation', () => {
  test.beforeEach(async ({ context }) => {
    const username = process.env.COLLAB_E2E_ADMIN;
    const password = process.env.COLLAB_E2E_PASSWORD;
    if (!username || !password) throw new Error('Admin navigation requires COLLAB_E2E_ADMIN and COLLAB_E2E_PASSWORD');
    const session = await loginUser(context.request, username, password);
    expect(session.user.role).toBe('admin');
    await authenticateContext(context, session);
  });

  test('admin sees all CE groups and can open AI Models directly', async ({ page }) => {
    await page.goto('/settings/ai/models');
    for (const name of ['Personal', 'Knowledge', 'AI', 'Governance', 'System']) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('nav-settings-models')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
    await expect(page.getByTestId('nav-settings-compliance')).toHaveCount(0);
  });
});
