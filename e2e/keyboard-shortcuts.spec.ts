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

  test('mobile navigation releases keyboard focus on desktop resize and stays closed on return', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const toggle = page.getByRole('button', { name: 'Open navigation menu' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
    await expect(drawer).toBeVisible();
    await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.setViewportSize({ width: 1024, height: 844 });
    await expect(drawer).toBeHidden();
    // Do not retain an exiting drawer behind md:hidden: it could flash back
    // into view if the viewport returns to mobile during the exit animation.
    await expect(page.locator('#mobile-nav-sidebar')).toHaveCount(0);
    const pages = page.getByRole('link', { name: 'Pages', exact: true }).filter({ visible: true });
    await pages.focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      return active !== document.body && !!active.getClientRects().length;
    })).toBe(true);
    await expect(pages).not.toBeFocused();
    await pages.focus();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      return active !== document.body && !!active.getClientRects().length;
    })).toBe(true);
    await expect(pages).not.toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).toBeHidden();
  });
});
