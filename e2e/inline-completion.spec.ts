import { expect, test } from '@playwright/test';

const PASSWORD = 'TestPassword123!';

test.describe('AI inline completion (#1417)', () => {
  test('shows ghost text, accepts full/word continuations, and dismisses with Escape', async ({ page }) => {
    const username = `e2e_inline_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const registration = await page.request.post('/api/auth/register', {
      data: { username, password: PASSWORD },
    });
    test.skip(!registration.ok(), 'Registration is unavailable in this E2E environment');
    const auth = await registration.json();
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    await page.request.post('/api/spaces/local', {
      headers,
      data: { key: `INL${Date.now().toString().slice(-4)}`, name: 'Inline completion' },
    });

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

    let completion = ' continuation';
    await page.route('**/api/llm/inline-completion', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          completion,
          provider: 'E2E provider',
          model: 'e2e-inline',
        }),
      }));

    await page.goto('/login');
    await page.evaluate(({ accessToken, user }) => {
      localStorage.setItem('compendiq-auth', JSON.stringify({
        state: { accessToken, user, isAuthenticated: true },
        version: 0,
      }));
    }, auth);
    await page.goto('/pages/new');

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
    await page.keyboard.press('Control+]');
    await expect(editor).toContainText('Start continuation with next ');
    await expect(ghost).toHaveText('words remain');

    await page.keyboard.press('Escape');
    await expect(ghost).toHaveCount(0);
    await expect(page.getByTestId('inline-completion-hint')).toHaveCount(0);
  });
});
