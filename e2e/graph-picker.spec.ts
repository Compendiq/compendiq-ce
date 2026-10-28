import { test, expect } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername } from './helpers/auth';

test('large graph picker distinguishes a failed search and retries against persisted pages', async ({ page }) => {
  const session = await registerUser(page.request, uniqueUsername('picker'));
  const headers = bearerHeaders(session);
  const spaceKey = `PK${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const ids: Array<number | string> = [];
  let spaceCreated = false;
  try {
    const space = await page.request.post('/api/spaces/local', { headers, data: { key: spaceKey, name: spaceKey } });
    expect(space.ok(), await space.text()).toBeTruthy();
    spaceCreated = true;
    for (let i = 0; i < 51; i++) {
      const created = await page.request.post('/api/pages', {
        headers, data: { title: `Pickerfixture ${i}`, bodyHtml: '<p>Fixture</p>', spaceKey, visibility: 'private' },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      ids.push((await created.json()).id);
    }
    await authenticateContext(page.context(), session);
    await page.goto('/graph');
    await expect(page.getByTestId('graph-picker-landing')).toBeVisible();
    const input = page.getByTestId('graph-picker-input');
    await input.fill('x');
    await expect(page.getByText('Type at least 2 characters to search.')).toBeVisible();
    await page.route('**/api/search?*', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
    await input.fill('Pickerfixture');
    await expect(page.getByRole('alert').filter({ hasText: 'Could not search pages' })).toBeVisible();
    await expect(page.getByTestId('graph-picker-no-results')).toHaveCount(0);
    await page.unroute('**/api/search?*');
    await page.getByRole('button', { name: 'Retry search' }).click();
    await expect(page.getByTestId('graph-picker-result').first()).toBeVisible();
    await input.fill('zzqxvwjk');
    await expect(page.getByTestId('graph-picker-no-results')).toBeVisible();
    await expect(page.getByTestId('graph-show-full-btn')).toBeVisible();
  } finally {
    for (const id of ids) {
      const deleted = await page.request.delete(`/api/pages/${id}?permanent=true`, { headers });
      expect(deleted.ok(), await deleted.text()).toBeTruthy();
    }
    if (spaceCreated) {
      const deleted = await page.request.delete(`/api/spaces/local/${spaceKey}`, { headers });
      expect(deleted.ok(), await deleted.text()).toBeTruthy();
    }
  }
});
