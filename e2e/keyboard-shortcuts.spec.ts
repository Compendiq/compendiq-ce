import { test, expect } from '@playwright/test';
import { authenticateContext, registerUser, uniqueUsername } from './helpers/auth';

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ context, page }) => {
    const session = await registerUser(context.request, uniqueUsername('e2e_kb'));
    expect(session.user.role).toBe('user');
    await authenticateContext(context, session);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
    // Keep keyboard shortcuts out of text-entry controls without clicking an
    // arbitrary body coordinate that might activate a card or focus search.
    await page.getByRole('heading', { name: 'Library', exact: true }).focus();
  });

  test('question mark opens shortcut discovery', async ({ page }) => {
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Navigation', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible();
  });

  test('Escape closes shortcut discovery', async ({ page }) => {
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('ControlOrMeta+K opens command palette and Escape closes it', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('ControlOrMeta+/ also opens shortcut discovery', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+/');
    const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Navigation', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
