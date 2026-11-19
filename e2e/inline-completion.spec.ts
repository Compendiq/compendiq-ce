import { expect, test } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername, type E2eUser } from './helpers/auth';

test.describe('AI inline completion (#1417)', () => {
  let auth: E2eUser;
  let fixturePageId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (fixturePageId === null) return;
    // Leave the editor before trashing only this test's article. Cleanup also
    // runs when a policy/identity or keyboard assertion fails.
    try {
      await page.goto('about:blank');
    } finally {
      const removed = await page.request.delete(`/api/pages/${fixturePageId}`, {
        headers: bearerHeaders(auth),
      });
      expect(removed.ok(), await removed.text()).toBeTruthy();
    }
  });

  test.beforeEach(async ({ page }) => {
    fixturePageId = null;
    auth = await registerUser(page.request, uniqueUsername('e2e_inline'));
    await authenticateContext(page.context(), auth);

    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          confluenceUrl: null,
          hasConfluencePat: false,
          selectedSpaces: [],
          theme: 'graphite',
          syncIntervalMin: 15,
          confluenceConnected: false,
          showSpaceHomeContent: true,
          customPrompts: {},
          confluencePatPromptDismissed: false,
          inlineCompletionEnabled: true,
          inlineCompletionDelay: 'fast',
          inlineCompletionMode: 'full',
          inlineCompletionCodeOnly: false,
        }),
      });
    });
    await page.route('**/api/llm/usecase-default?usecase=inline_completion', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          usecase: 'inline_completion',
          providerId: '00000000-0000-4000-8000-000000000141',
          providerName: 'E2E provider',
          model: 'e2e-inline',
          vision: null,
        }),
      }));
  });

  test('shows ghost text, accepts full/word continuations, and dismisses with Escape', async ({ page }) => {
    const spaceKey = `INLINE${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const space = await page.request.post('/api/spaces/local', {
      headers: bearerHeaders(auth), data: { key: spaceKey, name: spaceKey },
    });
    expect(space.ok(), await space.text()).toBeTruthy();
    const created = await page.request.post('/api/pages', {
      headers: bearerHeaders(auth),
      data: { title: 'Inline completion fixture', bodyHtml: '<p></p>', spaceKey, source: 'standalone', visibility: 'private', aiPolicy: 'all' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    // Capture the API-created identity before any subsequent assertion so a
    // failed detail/keyboard check cannot leave a live fixture behind.
    fixturePageId = String(id);
    expect(fixturePageId).toMatch(/^[1-9]\d*$/);
    const detail = await page.request.get(`/api/pages/${id}`, { headers: bearerHeaders(auth) });
    expect(detail.ok(), await detail.text()).toBeTruthy();
    const article = await detail.json();
    expect(String(article.id)).toBe(fixturePageId);
    expect(String(article.createdByUserId)).toBe(String(auth.user.id));
    expect(article).toMatchObject({
      spaceKey, source: 'standalone', visibility: 'private',
      aiPolicy: 'all', aiPolicyRevision: expect.any(Number),
    });

    // Only the generated text is synthetic. Page identity, ownership and fresh
    // policy/permission reads use the actual API, not mocked authorization.
    let completion = ' continuation';
    await page.route('**/api/llm/inline-completion', (route) => {
      expect(route.request().postDataJSON().pageId).toBe(Number(id));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ completion, provider: 'E2E provider', model: 'e2e-inline' }),
      });
    });

    await page.goto(`/pages/${id}`);
    await page.getByTestId('edit-page-btn').click();

    const editor = page.locator('.tiptap');
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.type('Start');
    const ghost = page.getByTestId('inline-completion-ghost');
    await expect(ghost).toHaveText(' continuation');
    await expect(page.getByTestId('inline-completion-hint')).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(editor).toContainText('Start continuation');
    await expect(ghost).toHaveCount(0);

    completion = ' next words remain';
    await page.keyboard.type(' with');
    await expect(ghost).toHaveText(' next words remain');
    await page.keyboard.press(process.platform === 'darwin' ? 'Alt+]' : 'Control+]');
    await expect(editor).toContainText('Start continuation with next ');
    await expect(ghost).toHaveText('words remain');

    await page.keyboard.press('Escape');
    await expect(ghost).toHaveCount(0);
    await expect(page.getByTestId('inline-completion-hint')).toHaveCount(0);
  });

  test('unsaved drafts issue no inline completion request', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/llm/inline-completion') requests.push(request.url());
    });
    await page.clock.install();
    const settings = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'GET');
    await page.goto('/pages/new');
    await settings;
    const editor = page.locator('.tiptap');
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.type('An unsaved draft must not dispatch');
    // Run beyond the completion debounce, rather than asserting before it fires.
    await page.clock.runFor(2_000);
    expect(requests).toEqual([]);
    await expect(page.getByTestId('inline-completion-ghost')).toHaveCount(0);
    await expect(editor).toContainText('An unsaved draft must not dispatch');
  });
});
