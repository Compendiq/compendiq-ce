import { test, expect, type Page } from '@playwright/test';
import { authenticateContext, registerUser, uniqueUsername } from './helpers/auth';

async function chooseTheme(page: Page, preference: 'system' | 'light' | 'dark') {
  await page.getByTestId('theme-toggle').click();
  await page.getByTestId(`theme-option-${preference}`).click();
}

test.describe('Theme preferences', () => {
  test.beforeEach(async ({ context, page }) => {
    const session = await registerUser(context.request, uniqueUsername('e2e_themes'));
    expect(session.user.role).toBe('user');
    await authenticateContext(context, session);
    await page.emulateMedia({ colorScheme: 'dark' });
    // Capture the inline bootstrap's first theme write, before the module
    // bundle can rehydrate React and potentially correct an incorrect flash.
    await context.addInitScript(() => {
      sessionStorage.removeItem('e2e-bootstrap-theme');
      const observer = new MutationObserver((records) => {
        if (!records.some((record) => record.type === 'attributes' && record.attributeName === 'data-theme')) return;
        sessionStorage.setItem('e2e-bootstrap-theme', JSON.stringify({
          theme: document.documentElement.getAttribute('data-theme'),
          type: document.documentElement.getAttribute('data-theme-type'),
        }));
        observer.disconnect();
      });
      observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
    });
  });

  test('first paint follows the OS for a fresh visitor', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e-bootstrap-theme')!))).toEqual({ theme: 'paper', type: 'light' });
    await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Theme: System');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  });

  test('header preference switches dark to light', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    await chooseTheme(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
    await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Theme: Light');
  });

  test('header preference switches light to dark', async ({ page }) => {
    await page.goto('/');
    await chooseTheme(page, 'light');
    await chooseTheme(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark');
    await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Theme: Dark');
  });

  test('an explicit choice survives reload without reverting to the OS', async ({ page }) => {
    await page.goto('/');
    await chooseTheme(page, 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Theme: Light');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e-bootstrap-theme')!))).toEqual({ theme: 'paper', type: 'light' });
    await chooseTheme(page, 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
  });

  for (const [retired, replacement, type] of [
    ['void-indigo', 'graphite', 'dark'],
    ['honey-linen', 'paper', 'light'],
    ['graphite-honey', 'graphite', 'dark'],
    ['frost-steel', 'paper', 'light'],
  ] as const) {
    test(`legacy ${retired} preserves brightness before and after rehydration`, async ({ page }) => {
      // Choose the opposite OS preference: a migration that falls back to
      // System would otherwise accidentally pass for the dark legacy cases.
      await page.emulateMedia({ colorScheme: type === 'light' ? 'dark' : 'light' });
      // Seed the old installation before boot, not while the current store is
      // still hydrating and can overwrite an out-of-band storage edit.
      await page.addInitScript((theme) => {
        localStorage.setItem('compendiq-theme', JSON.stringify({ state: { theme }, version: 0 }));
      }, retired);
      await page.goto('/');
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e-bootstrap-theme')!))).toEqual({ theme: replacement, type });
      await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName(`Theme: ${type === 'light' ? 'Light' : 'Dark'}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', replacement);
      await expect(page.locator('html')).toHaveAttribute('data-theme-type', type);
    });
  }

  test('appearance offers only the current palettes and marks the active one', async ({ page }) => {
    await page.goto('/settings/personal/theme');
    await expect(page.getByTestId('theme-grid').getByRole('button')).toHaveCount(2);
    await expect(page.getByTestId('theme-graphite')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('theme-paper')).toHaveAttribute('aria-pressed', 'false');
  });

  test('selecting a palette applies it and persists it to the profile', async ({ page }) => {
    await page.goto('/settings/personal/theme');
    const saved = page.waitForResponse((res) => res.url().endsWith('/api/settings') && res.request().method() === 'PUT' && res.request().postDataJSON()?.theme === 'paper');
    await page.getByTestId('theme-paper').click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(page.getByTestId('theme-paper')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('theme-graphite')).toHaveAttribute('aria-pressed', 'false');
  });
});
