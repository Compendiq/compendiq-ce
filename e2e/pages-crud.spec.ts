import { test, expect } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername, type E2eUser } from './helpers/auth';

// Each case owns its user and local space; API setup failures must fail, not skip.
test.describe('Pages CRUD', () => {
  let session: E2eUser;
  let spaceKey: string;
  test.beforeEach(async ({ page }) => {
    session = await registerUser(page.request, uniqueUsername('e2e_pages'));
    await authenticateContext(page.context(), session);
    spaceKey = `CRUD${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const space = await page.request.post('/api/spaces/local', {
      headers: bearerHeaders(session), data: { key: spaceKey, name: spaceKey },
    });
    expect(space.ok(), await space.text()).toBeTruthy();
  });

  test('create a standalone page', async ({ page }) => {
    const title = uniqueUsername('Created page');
    await page.goto('/pages/new');
    await page.getByLabel('Select space').selectOption(spaceKey);
    await page.getByLabel('Page title', { exact: true }).fill(title);
    await page.locator('.tiptap').fill('Content saved through the editor.');
    await page.getByRole('button', { name: 'Create Page', exact: true }).click();
    await expect(page).toHaveURL(/\/pages\/\d+$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('Content saved through the editor.', { exact: true })).toBeVisible();
  });

  test('edit an existing page title', async ({ page }) => {
    const created = await page.request.post('/api/pages', {
      headers: bearerHeaders(session),
      data: { title: 'Before editing', bodyHtml: '<p>Initial content</p>', spaceKey },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    await page.goto(`/pages/${id}`);
    await page.getByTestId('edit-page-btn').click();
    await page.getByLabel('Page title', { exact: true }).fill('Updated title');
    await page.getByTestId('save-page-btn').click();
    await expect(page.getByTestId('edit-page-btn')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Updated title', exact: true })).toBeVisible();
  });

  for (const surface of ['new', 'edit'] as const) {
    test(`title reflows on viewport and adjacent panel resizing in ${surface} mode`, async ({ page }, testInfo) => {
      const title = 'A long incident response title describing database saturation and recovery during the busiest production hours';
      await page.setViewportSize({ width: 1500, height: 900 });
      if (surface === 'new') {
        await page.goto('/pages/new');
      } else {
        const created = await page.request.post('/api/pages', {
          headers: bearerHeaders(session), data: { title, bodyHtml: '<p>Content</p>', spaceKey },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const { id } = await created.json();
        await page.goto(`/pages/${id}`);
        await page.getByTestId('edit-page-btn').click();
      }
      const field = page.getByLabel('Page title', { exact: true });
      if (surface === 'new') await field.fill(title);
      const measure = () => field.evaluate((el: HTMLTextAreaElement) => ({
        width: el.clientWidth, height: el.clientHeight, scroll: el.scrollHeight, value: el.value,
      }));
      const assertFits = async () => {
        await expect.poll(async () => {
          const m = await measure();
          return m.scroll - m.height;
        }).toBeLessThanOrEqual(1);
        expect((await measure()).value).toBe(title);
      };
      await assertFits();
      const wide = await measure();
      await testInfo.attach('wide', { body: await page.screenshot(), contentType: 'image/png' });
      await page.setViewportSize({ width: 800, height: 900 });
      await assertFits();
      const narrow = await measure();
      await testInfo.attach('narrow', { body: await page.screenshot(), contentType: 'image/png' });
      expect(narrow.width).toBeLessThan(wide.width);
      expect(narrow.height).toBeGreaterThan(wide.height);
      await page.setViewportSize({ width: 1500, height: 900 });
      await assertFits();
      expect((await measure()).height).toBeLessThan(narrow.height);
      const separator = page.getByRole('separator', { name: 'Resize tree sidebar' });
      const start = await separator.boundingBox();
      if (!start) throw new Error('Tree resize handle is not visible');
      const beforePanel = await measure();
      await page.mouse.move(start.x + start.width / 2, start.y + 100);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + 300, start.y + 100, { steps: 10 });
      await page.mouse.up();
      await expect.poll(async () => (await measure()).width).toBeLessThan(beforePanel.width);
      await assertFits();
      const panelNarrow = await measure();
      expect(panelNarrow.height).toBeGreaterThan(beforePanel.height);
      await testInfo.attach('panel-narrow', { body: await page.screenshot(), contentType: 'image/png' });
      await separator.dblclick();
      await expect.poll(async () => (await measure()).width).toBeGreaterThan(panelNarrow.width);
      await assertFits();
      const panelWide = await measure();
      expect(panelWide.height).toBeLessThan(panelNarrow.height);
      await testInfo.attach('panel-wide', { body: await page.screenshot(), contentType: 'image/png' });
      await testInfo.attach('dimensions', {
        body: JSON.stringify({ wide, narrow, beforePanel, panelNarrow, panelWide }, null, 2),
        contentType: 'application/json',
      });
    });
  }

  test('add a tag to a page', async ({ page }) => {
    const created = await page.request.post('/api/pages', {
      headers: bearerHeaders(session),
      data: { title: 'Tag test', bodyHtml: '<p>Tag test content</p>', spaceKey },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    await page.goto(`/pages/${id}`);
    await page.getByTestId('edit-page-btn').click();
    await page.getByTestId('tag-popover-trigger').click();
    await page.getByPlaceholder('Add a tag...').fill('e2e-test-tag');
    await page.getByPlaceholder('Add a tag...').press('Enter');
    await page.getByTestId('tag-popover-trigger').click();
    await page.getByTestId('save-page-btn').click();
    await expect(page.getByTestId('edit-page-btn')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('article-tags-readonly')).toContainText('e2e-test-tag');
  });

  test('move a page to trash', async ({ page }) => {
    const created = await page.request.post('/api/pages', {
      headers: bearerHeaders(session),
      data: { title: 'Trash test', bodyHtml: '<p>To be trashed</p>', spaceKey },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    await page.goto(`/pages/${id}`);
    await expect(page.getByTestId('edit-page-btn')).toBeVisible();
    await page.keyboard.press('Alt+Shift+d');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page).toHaveURL(/\/$/);
    const removed = await page.request.get(`/api/pages/${id}`, { headers: bearerHeaders(session) });
    expect(removed.status()).toBe(404);
  });

  test('search for a created page', async ({ page }) => {
    const title = uniqueUsername('Searchable');
    const created = await page.request.post('/api/pages', {
      headers: bearerHeaders(session),
      data: { title, bodyHtml: '<p>Search fixture</p>', spaceKey },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    // Keyword search needs no model; its result still comes from the real DB.
    await page.goto('/?mode=keyword');
    await page.getByTestId('page-search-field').getByRole('textbox').fill(title);
    const result = page.getByRole('region', { name: 'Page results', exact: true }).getByText(title, { exact: true });
    await expect(result).toBeVisible();
  });
});
