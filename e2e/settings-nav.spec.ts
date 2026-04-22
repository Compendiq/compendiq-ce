import { test, expect } from '@playwright/test';

/**
 * E2E: Settings page — left-rail navigation (issue #215).
 *
 * Covers the new nested-route layout: deep-link, keyboard nav, admin-only
 * gating, legacy `?tab=<id>` redirect, browser back/forward. The older
 * `settings.spec.ts` still exercises smoke-level tab switching; this spec
 * focuses on the IA reorg acceptance criteria.
 */

const TEST_USER = `e2e_nav_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Settings page — left-rail navigation', () => {
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
      { accessToken: data.accessToken, user: authUser },
    );
  });

  test('deep link to /settings/personal/theme lands on the Theme panel', async ({ page }) => {
    await page.goto('/settings/personal/theme');
    await expect(page).toHaveURL(/\/settings\/personal\/theme/, { timeout: 10_000 });

    // `aria-current="page"` marks the active rail link.
    const themeLink = page.getByTestId('nav-settings-theme');
    await expect(themeLink).toBeVisible({ timeout: 10_000 });
    await expect(themeLink).toHaveAttribute('aria-current', 'page');

    // Content pane shows Theme-related copy.
    await expect(
      page.getByText(/theme|appearance|dark|light/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('/settings (no path) redirects to the first visible panel', async ({ page }) => {
    await page.goto('/settings');
    // Non-admin default lands on /settings/personal/confluence.
    // Admin accounts land on the same (see firstVisiblePath — Personal is first).
    await expect(page).toHaveURL(/\/settings\/personal\/confluence/, { timeout: 10_000 });
    await expect(page.getByTestId('nav-settings-confluence')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('legacy ?tab=<id> URLs redirect to the canonical nested path', async ({ page }) => {
    // ?tab=theme → /settings/personal/theme
    await page.goto('/settings?tab=theme');
    await expect(page).toHaveURL(/\/settings\/personal\/theme/, { timeout: 10_000 });

    // ?tab=sync → /settings/content/sync
    await page.goto('/settings?tab=sync');
    await expect(page).toHaveURL(/\/settings\/content\/sync/, { timeout: 10_000 });
  });

  test('legacy ?tab=ollama → /settings/ai/llm (URL-segment rename)', async ({ page }) => {
    if (authUser.role !== 'admin') {
      test.skip();
      return;
    }
    await page.goto('/settings?tab=ollama');
    await expect(page).toHaveURL(/\/settings\/ai\/llm/, { timeout: 10_000 });
    await expect(page.getByTestId('nav-settings-llm')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('unknown ?tab=<x> falls back to the default panel', async ({ page }) => {
    await page.goto('/settings?tab=does-not-exist');
    await expect(page).toHaveURL(/\/settings\/personal\/confluence/, { timeout: 10_000 });
  });

  test('clicking a rail link updates the URL and aria-current', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await expect(page.getByTestId('nav-settings-confluence')).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByTestId('nav-settings-theme').click();

    await expect(page).toHaveURL(/\/settings\/personal\/theme/);
    await expect(page.getByTestId('nav-settings-theme')).toHaveAttribute(
      'aria-current',
      'page',
    );
    // And the previously-active link no longer claims the current page.
    await expect(page.getByTestId('nav-settings-confluence')).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('keyboard: Tab reaches rail links in DOM order; Enter activates', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await expect(page.getByTestId('nav-settings-confluence')).toBeVisible({ timeout: 10_000 });

    // Focus the first rail link (Confluence) and tab through a few.
    await page.getByTestId('nav-settings-confluence').focus();
    await expect(page.getByTestId('nav-settings-confluence')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('nav-settings-ai-prompts')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('nav-settings-theme')).toBeFocused();

    // Enter activates the focused link → URL updates.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/personal\/theme/);
  });

  test('browser back/forward navigates between panels', async ({ page }) => {
    await page.goto('/settings/personal/confluence');
    await page.getByTestId('nav-settings-theme').click();
    await expect(page).toHaveURL(/\/settings\/personal\/theme/);

    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/personal\/confluence/);

    await page.goForward();
    await expect(page).toHaveURL(/\/settings\/personal\/theme/);
  });

  test('admin sees the AI / Integrations / Security / System groups', async ({ page }) => {
    if (authUser.role !== 'admin') {
      test.skip();
      return;
    }
    await page.goto('/settings/personal/confluence');

    // Group headers (rendered as real <h2>).
    await expect(page.getByRole('heading', { name: 'Personal' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Content' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Security & Access' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();

    // Core admin items.
    await expect(page.getByTestId('nav-settings-llm')).toBeVisible();
    await expect(page.getByTestId('nav-settings-embedding')).toBeVisible();
    await expect(page.getByTestId('nav-settings-workers')).toBeVisible();
    await expect(page.getByTestId('nav-settings-email')).toBeVisible();
    await expect(page.getByTestId('nav-settings-rate-limits')).toBeVisible();
    await expect(page.getByTestId('nav-settings-license')).toBeVisible();
    await expect(page.getByTestId('nav-settings-system')).toBeVisible();
  });

  test('non-admin cannot reach an admin-only panel via direct URL', async ({ page }) => {
    if (authUser.role === 'admin') {
      test.skip();
      return;
    }
    // Direct navigation to /settings/ai/llm (admin-only) must bounce.
    await page.goto('/settings/ai/llm');
    await expect(page).toHaveURL(/\/settings\/personal\/confluence/, { timeout: 10_000 });
  });

  test('unknown /settings/foo/bar falls back to the default panel', async ({ page }) => {
    await page.goto('/settings/foo/bar');
    await expect(page).toHaveURL(/\/settings\/personal\/confluence/, { timeout: 10_000 });
  });
});
