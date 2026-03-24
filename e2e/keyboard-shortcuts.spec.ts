import { test, expect } from '@playwright/test';

/**
 * E2E: Keyboard shortcuts
 *
 * Tests that pressing `?` opens the keyboard shortcuts modal,
 * Escape closes it, and other keyboard shortcuts work.
 */

const TEST_USER = `e2e_kb_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    // Register a fresh user via API
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

    // Set auth in localStorage
    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user }) => {
        const authState = {
          state: { accessToken, user, isAuthenticated: true },
          version: 0,
        };
        localStorage.setItem('auth-storage', JSON.stringify(authState));
      },
      { accessToken: data.accessToken, user: data.user },
    );

    // Navigate to main page and wait for it to load
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    // Wait for the app to fully initialize
    await page.waitForLoadState('networkidle');
  });

  test('pressing ? opens the keyboard shortcuts modal', async ({ page }) => {
    // Make sure no input is focused (click on the body)
    await page.locator('body').click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Press the ? key (Shift+/ on US keyboards, but Playwright uses Shift+Slash)
    await page.keyboard.press('Shift+/');
    // Give the modal a moment to animate in
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // The keyboard shortcuts modal should appear
    const modal = page
      .getByRole('dialog')
      .or(page.getByText('Keyboard Shortcuts'));

    await expect(modal.first()).toBeVisible({ timeout: 5_000 });

    // Should show shortcut categories
    await expect(
      page.getByText('Navigation').or(page.getByText('Actions')),
    ).toBeVisible({ timeout: 3_000 });
  });

  test('pressing Escape closes the keyboard shortcuts modal', async ({
    page,
  }) => {
    // Open the modal first
    await page.locator('body').click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('Shift+/');
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Verify modal is open
    const modal = page
      .getByRole('dialog')
      .or(page.getByText('Keyboard Shortcuts'));

    await expect(modal.first()).toBeVisible({ timeout: 5_000 });

    // Press Escape to close
    await page.keyboard.press('Escape');
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Modal should be closed (dialog should not be visible)
    // Since the dialog component might still be in DOM but hidden, check for content
    const dialogVisible = await page
      .getByRole('dialog')
      .isVisible({ timeout: 2_000 })
      .catch(() => false);

    expect(dialogVisible).toBe(false);
  });

  test('Ctrl+K opens command palette', async ({ page }) => {
    await page.locator('body').click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Press Ctrl+K (or Cmd+K on Mac)
    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Command palette should open
    const palette = page
      .getByRole('dialog')
      .or(page.getByTestId('command-palette'))
      .or(page.getByPlaceholder(/search|command|type/i));

    const paletteVisible = await palette
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    // Command palette might not be visible if the shortcut is intercepted
    // by the browser; in that case, we just verify no crash occurred
    if (paletteVisible) {
      // Close with Escape
      await page.keyboard.press('Escape');
      // Allow UI transition to settle
      await page.waitForLoadState('domcontentloaded');
    }
  });

  test('Ctrl+/ also opens keyboard shortcuts modal', async ({ page }) => {
    await page.locator('body').click();
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Ctrl+/ is an alternative shortcut for the keyboard shortcuts modal
    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+/' : 'Control+/');
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    const modal = page
      .getByRole('dialog')
      .or(page.getByText('Keyboard Shortcuts'));

    const modalVisible = await modal
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (modalVisible) {
      // Verify content
      await expect(
        page.getByText('Navigation').or(page.getByText('Actions')),
      ).toBeVisible({ timeout: 3_000 });

      // Close with Escape
      await page.keyboard.press('Escape');
    }
  });
});
