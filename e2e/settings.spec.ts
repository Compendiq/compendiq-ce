import { test, expect } from '@playwright/test';
import { authenticateContext, loginUser, registerUser, uniqueUsername } from './helpers/auth';

test.describe('Settings page', () => {
  test.beforeEach(async ({ context }) => {
    const session = await registerUser(context.request, uniqueUsername('e2e_settings'));
    expect(session.user.role).toBe('user');
    await authenticateContext(context, session);
  });

  test('displays personal and knowledge panels without admin controls', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/personal\/confluence$/);
    for (const panel of ['confluence', 'ai-prompts', 'editor', 'theme', 'spaces']) {
      await expect(page.getByTestId(`nav-settings-${panel}`)).toBeVisible();
    }
    await expect(page.getByTestId('nav-settings-models')).toHaveCount(0);
    await expect(page.getByTestId('nav-settings-access')).toHaveCount(0);
  });

  test('requires a verified Confluence connection before saving', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await expect(page.getByLabel('Confluence URL', { exact: true })).toBeEditable();
    await expect(page.getByLabel('Personal Access Token', { exact: true })).toBeEditable();
    await expect(page.getByRole('button', { name: 'Test Connection', exact: true })).toBeDisabled();
    await expect(page.getByTestId('confluence-save-btn')).toBeDisabled();
  });

  test('switches between appearance and spaces/sync panels', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('nav-settings-theme').click();
    await expect(page.getByTestId('theme-graphite')).toBeVisible();
    await page.getByTestId('nav-settings-spaces').click();
    await expect(page.getByRole('tab', { name: 'Spaces', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Sync schedule', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Sync schedule', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sync-overview-refresh')).toBeVisible();
  });
});

test.describe('Admin settings page', () => {
  test.beforeEach(async ({ context }) => {
    const username = process.env.COLLAB_E2E_ADMIN;
    const password = process.env.COLLAB_E2E_PASSWORD;
    if (!username || !password) throw new Error('Admin settings require COLLAB_E2E_ADMIN and COLLAB_E2E_PASSWORD');
    const session = await loginUser(context.request, username, password);
    expect(session.user.role).toBe('admin');
    await authenticateContext(context, session);
  });

  test('shows admin panels', async ({ page }) => {
    await page.goto('/settings');
    for (const panel of ['models', 'labels', 'ai-safety', 'access', 'integrations', 'license', 'backup', 'diagnostics']) {
      await expect(page.getByTestId(`nav-settings-${panel}`)).toBeVisible();
    }
  });

  test('AI Models exposes provider configuration and specialist subpanels', async ({ page }) => {
    await page.goto('/settings/ai/models');
    await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
    for (const name of ['LLM providers', 'Embeddings', 'Retrieval', 'Client inference', 'Workers']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
  });
});
