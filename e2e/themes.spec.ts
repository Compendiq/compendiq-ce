import { test, expect } from '@playwright/test';

/**
 * E2E: Theme switching (Honey Linen + Graphite Honey, #30)
 *
 * Verifies:
 *  - First paint applies graphite-honey on a fresh visit (FOUC prevention).
 *  - The header theme toggle swaps between graphite-honey and honey-linen.
 *  - data-theme + data-theme-type attributes update on <html>.
 *  - The change persists to localStorage under `compendiq-theme`.
 *  - A persisted retired theme ID falls back to graphite-honey on reload.
 *  - Settings → Theme tab renders exactly the two current themes.
 */

const TEST_USER = `e2e_themes_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Theme switching', () => {
  let authToken: string;
  let authUser: { id: string; username: string; role: string };

  test.beforeEach(async ({ page }) => {
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

  test('first paint applies graphite-honey (no FOUC)', async ({ page }) => {
    await page.goto('/');

    const dataTheme = await page.locator('html').getAttribute('data-theme');
    const dataThemeType = await page.locator('html').getAttribute('data-theme-type');

    expect(dataTheme).toBe('graphite-honey');
    expect(dataThemeType).toBe('dark');
  });

  test('header toggle switches graphite-honey → honey-linen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite-honey');

    const toggle = page.getByRole('button', { name: /switch to light mode/i });
    await toggle.click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'honey-linen');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
  });

  test('header toggle switches honey-linen → graphite-honey', async ({ page }) => {
    await page.goto('/');

    // First flip to light
    await page.getByRole('button', { name: /switch to light mode/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'honey-linen');

    // Then back to dark
    await page.getByRole('button', { name: /switch to dark mode/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite-honey');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark');
  });

  test('theme choice persists to localStorage and survives reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /switch to light mode/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'honey-linen');

    // Persisted under compendiq-theme key
    const persisted = await page.evaluate(() => localStorage.getItem('compendiq-theme'));
    expect(persisted).toBeTruthy();
    expect(persisted).toContain('honey-linen');

    // Survives reload (FOUC-prevention script in index.html honours the persisted choice)
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'honey-linen');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
  });

  test('persisted retired theme ID falls back to graphite-honey', async ({ page }) => {
    await page.goto('/');

    // Inject a retired theme ID into localStorage as if from an older client
    await page.evaluate(() => {
      localStorage.setItem(
        'compendiq-theme',
        JSON.stringify({ state: { theme: 'void-indigo' }, version: 0 }),
      );
    });

    await page.reload();

    // The validateThemeId path should drop void-indigo and the FOUC script's
    // VALID map should refuse to apply it; both routes settle on the default.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite-honey');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark');
  });

  test('Settings → Theme tab renders exactly the two current themes', async ({ page }) => {
    await page.goto('/settings');

    // Click the Theme tab
    await page.getByTestId('tab-theme').click();

    // Both expected themes present
    await expect(page.getByTestId('theme-graphite-honey')).toBeVisible();
    await expect(page.getByTestId('theme-honey-linen')).toBeVisible();

    // Retired themes absent
    await expect(page.getByTestId('theme-void-indigo')).toHaveCount(0);
    await expect(page.getByTestId('theme-obsidian-violet')).toHaveCount(0);
    await expect(page.getByTestId('theme-polar-slate')).toHaveCount(0);
    await expect(page.getByTestId('theme-parchment-glow')).toHaveCount(0);

    // Active badge is on graphite-honey (the current theme after fresh visit)
    const activeCard = page.getByTestId('theme-graphite-honey');
    await expect(activeCard.locator('[data-testid="theme-active-badge"]')).toBeVisible();
  });

  test('clicking a theme card in Settings switches the theme', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('tab-theme').click();

    await page.getByTestId('theme-honey-linen').click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'honey-linen');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
  });
});
