import { test, expect } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername } from './helpers/auth';

test('persisted note replies survive inspector and popover transitions', async ({ page }) => {
  const session = await registerUser(page.request, uniqueUsername('notes'));
  await authenticateContext(page.context(), session);
  const headers = bearerHeaders(session);
  const key = `NOTES${Date.now()}`;
  const space = await page.request.post('/api/spaces/local', { headers, data: { key, name: key } });
  expect(space.ok(), await space.text()).toBeTruthy();
  const created = await page.request.post('/api/pages', {
    headers, data: { title: 'Note reply persistence', bodyHtml: '<p>Anchored text</p>', spaceKey: key },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id } = await created.json();
  const parent = await page.request.post(`/api/pages/${id}/comments`, {
    headers, data: { body: 'Parent note', anchorType: 'selection', anchorData: { quote: 'Anchored text' } },
  });
  expect(parent.ok(), await parent.text()).toBeTruthy();
  const note = await parent.json();
  const reply = await page.request.post(`/api/pages/${id}/comments`, {
    headers, data: { body: 'Persisted reply', parentId: note.id },
  });
  expect(reply.ok(), await reply.text()).toBeTruthy();
  const list = await page.request.get(`/api/pages/${id}/comments?includeResolved=true`, { headers });
  expect((await list.json()).comments[0].replies).toHaveLength(1);

  await page.goto(`/pages/${id}`);
  await page.getByTestId('page-context-tab-details').click();
  const thread = page.getByTestId(`comment-thread-${note.id}`);
  await expect(thread).toContainText('Persisted reply');
  await expect(thread).toContainText('1 reply');
  await thread.getByTestId(`reply-toggle-${note.id}`).click();
  await thread.getByPlaceholder('Write a reply...').fill('New inspector reply');
  await thread.getByTestId('comment-submit').click();
  await expect(thread).toContainText('New inspector reply');
  await expect(thread).toContainText('2 replies');
  await page.reload();
  await page.getByTestId('page-context-tab-details').click();
  await expect(thread).toContainText('Persisted reply');
  await expect(thread).toContainText('New inspector reply');
  await expect(page.locator('.article-viewer .tiptap')).toBeVisible();
  await expect(thread).toContainText('2 replies');
  await page.evaluate((commentId) => window.dispatchEvent(new CustomEvent('compendiq:comment-select', {
    detail: { commentId: String(commentId), rect: { top: 150, left: 150, width: 50, height: 20 } },
  })), note.id);
  const popover = page.getByTestId('comment-popover-content');
  await expect(popover).toContainText('Persisted reply');
  await expect(popover).toContainText('New inspector reply');
  await popover.getByTestId('popover-reply-toggle-btn').click();
  await popover.getByTestId('popover-reply-input').fill('New popover reply');
  await popover.getByTestId('popover-reply-submit-btn').click();
  await expect(popover).toContainText('New popover reply');
  await expect(popover).toContainText('Replies (3)');
  await page.keyboard.press('Escape');
  await expect(thread).toContainText('3 replies');
  await expect(thread).toContainText('New popover reply');
});
