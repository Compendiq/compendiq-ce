import { test, expect } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername, type E2eUser } from './helpers/auth';

test.describe('Keyboard shortcuts', () => {
  let session: E2eUser;
  test.beforeEach(async ({ context, page }) => {
    session = await registerUser(context.request, uniqueUsername('e2e_kb'));
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

  test('palette binds page results to the current query through debounce and request', async ({ page }, testInfo) => {
    const spaceKey = `PAL${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const space = await page.request.post('/api/spaces/local', {
      headers: bearerHeaders(session), data: { key: spaceKey, name: spaceKey },
    });
    expect(space.ok(), await space.text()).toBeTruthy();
    const firstTitle = uniqueUsername('PaletteFirst');
    const secondTitle = uniqueUsername('PaletteSecond');
    for (const title of [firstTitle, secondTitle]) {
      const created = await page.request.post('/api/pages', {
        headers: bearerHeaders(session),
        data: { title, bodyHtml: '<p>Palette fixture</p>', spaceKey },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
    }
    const pending = Promise.withResolvers<void>();
    const requestStarted = Promise.withResolvers<void>();
    await page.route('**/api/pages?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('search') !== secondTitle) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      requestStarted.resolve();
      await pending.promise;
      await route.fulfill({ response });
    });
    await page.goto('/');
    await page.getByRole('heading', { name: 'Library', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const input = palette.getByRole('combobox');
    await input.fill(firstTitle);
    const firstRow = palette.getByRole('option', { name: new RegExp(firstTitle) });
    await expect(firstRow).toBeVisible();
    const firstBounds = await firstRow.boundingBox();
    expect(firstBounds).not.toBeNull();
    await input.fill(secondTitle);
    await page.mouse.click(firstBounds!.x + 10, firstBounds!.y + firstBounds!.height / 2);
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('option', { name: new RegExp(firstTitle) })).toHaveCount(0);
    await expect(palette.getByRole('status')).toHaveText('Searching...');
    await input.press('Enter');
    await expect(palette).toBeVisible();
    await requestStarted.promise;
    await expect(palette.getByRole('option', { name: new RegExp(firstTitle) })).toHaveCount(0);
    await page.mouse.click(firstBounds!.x + 10, firstBounds!.y + firstBounds!.height / 2);
    await expect(palette).toBeVisible();
    await input.press('Enter');
    await expect(palette).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('pending.png') });
    pending.resolve();
    await expect(palette.getByRole('option', { name: new RegExp(secondTitle) })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('resolved.png') });
    await input.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('heading', { name: secondTitle, exact: true })).toBeVisible();
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
