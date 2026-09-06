import { expect, test } from '@playwright/test';
import { authenticateContext, registerUser, uniqueUsername } from './helpers/auth';

test.describe('AI inline completion (#1417)', () => {
  test('shows ghost text, accepts full/word continuations, and dismisses with Escape', async ({ page }) => {
    const auth = await registerUser(page.request, uniqueUsername('e2e_inline'));
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
    await page.keyboard.press(process.platform === 'darwin' ? 'Alt+]' : 'Control+]');
    await expect(editor).toContainText('Start continuation with next ');
    await expect(ghost).toHaveText('words remain');

    await page.keyboard.press('Escape');
    await expect(ghost).toHaveCount(0);
    await expect(page.getByTestId('inline-completion-hint')).toHaveCount(0);
  });
});
