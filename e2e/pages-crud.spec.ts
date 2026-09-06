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
