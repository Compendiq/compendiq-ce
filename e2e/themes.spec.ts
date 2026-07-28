import { test, expect } from '@playwright/test';

/**
 * E2E: Theme switching (Frost Steel + Slate Steel, #30)
 *
 * Verifies:
 *  - First paint applies slate-steel on a fresh visit (FOUC prevention).
 *  - The header theme toggle swaps between slate-steel and frost-steel.
 *  - data-theme + data-theme-type attributes update on <html>.
 *  - The change persists to localStorage under `compendiq-theme`.
 *  - A persisted retired theme ID falls back to slate-steel on reload.
 *  - The retired honey pair migrates to its steel replacement before first
 *    paint, preserving brightness (honey-linen → frost-steel stays light).
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

  test('first paint applies slate-steel (no FOUC)', async ({ page }) => {
    await page.goto('/');

    const dataTheme = await page.locator('html').getAttribute('data-theme');
    const dataThemeType = await page.locator('html').getAttribute('data-theme-type');

    expect(dataTheme).toBe('slate-steel');
    expect(dataThemeType).toBe('dark');
  });

  test('header toggle switches slate-steel → frost-steel', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-steel');

    const toggle = page.getByRole('button', { name: /switch to light mode/i });
    await toggle.click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'frost-steel');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
  });

  test('header toggle switches frost-steel → slate-steel', async ({ page }) => {
    await page.goto('/');

    // First flip to light
    await page.getByRole('button', { name: /switch to light mode/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'frost-steel');

    // Then back to dark
    await page.getByRole('button', { name: /switch to dark mode/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-steel');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark');
  });

  test('theme choice persists to localStorage and survives reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /switch to light mode/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'frost-steel');

    // Persisted under compendiq-theme key
    const persisted = await page.evaluate(() => localStorage.getItem('compendiq-theme'));
    expect(persisted).toBeTruthy();
    expect(persisted).toContain('frost-steel');

    // Survives reload (FOUC-prevention script in index.html honours the persisted choice)
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'frost-steel');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
  });

  test('persisted retired theme ID falls back to slate-steel', async ({ page }) => {
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
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate-steel');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark');
  });

  // The honey → steel rebrand retired both previous theme IDs. Upgrading users
  // hold them in localStorage, so each must migrate to the replacement of the
  // SAME brightness — and must do so in the FOUC script, before first paint,
  // or a light-theme user gets a full-brightness flash on every page load.
  for (const [retired, replacement, type] of [
    ['honey-linen', 'frost-steel', 'light'],
    ['graphite-honey', 'slate-steel', 'dark'],
  ] as const) {
    test(`retired ${retired} migrates to ${replacement} before first paint`, async ({ page }) => {
      await page.goto('/');
      await page.evaluate((theme) => {
        localStorage.setItem(
          'compendiq-theme',
          JSON.stringify({ state: { theme }, version: 0 }),
        );
      }, retired);

      // Read the attributes the inline FOUC script set, captured as early as
      // the document element exists — before React has had a chance to correct
      // them. If the migration only lived in the store, this would read the
      // <html> default (slate-steel/dark) and the light case would fail here.
      await page.reload({ waitUntil: 'commit' });
      const atFirstPaint = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        type: document.documentElement.getAttribute('data-theme-type'),
      }));

      expect(atFirstPaint.theme).toBe(replacement);
      expect(atFirstPaint.type).toBe(type);

      // And it stays there once the store rehydrates — no late correction.
      await expect(page.locator('html')).toHaveAttribute('data-theme', replacement);
      await expect(page.locator('html')).toHaveAttribute('data-theme-type', type);
    });
  }

  test('Settings → Theme tab renders exactly the two current themes', async ({ page }) => {
    await page.goto('/settings');

    // Click the Theme tab
    await page.getByTestId('tab-theme').click();

    // Both expected themes present
    await expect(page.getByTestId('theme-slate-steel')).toBeVisible();
    await expect(page.getByTestId('theme-frost-steel')).toBeVisible();

    // Retired themes absent
    await expect(page.getByTestId('theme-void-indigo')).toHaveCount(0);
    await expect(page.getByTestId('theme-obsidian-violet')).toHaveCount(0);
    await expect(page.getByTestId('theme-polar-slate')).toHaveCount(0);
    await expect(page.getByTestId('theme-parchment-glow')).toHaveCount(0);

    // Active badge is on slate-steel (the current theme after fresh visit)
    const activeCard = page.getByTestId('theme-slate-steel');
    await expect(activeCard.locator('[data-testid="theme-active-badge"]')).toBeVisible();
  });

  test('clicking a theme card in Settings switches the theme', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('tab-theme').click();

    await page.getByTestId('theme-frost-steel').click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'frost-steel');
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'light');
  });
});
