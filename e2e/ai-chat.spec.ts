import { test, expect } from '@playwright/test';
import { authenticateContext, registerUser, uniqueUsername } from './helpers/auth';

test.describe('AI Chat', () => {
  test.beforeEach(async ({ context }) => {
    const session = await registerUser(context.request, uniqueUsername('e2e_ai'));
    expect(session.user.role).toBe('user');
    await authenticateContext(context, session);
  });

  test('offers current standalone chat and creation skills', async ({ page }) => {
    await page.goto('/ai');
    const action = page.getByTestId('assistant-action-select');
    await expect(action).toHaveAccessibleName('Selected action: Q&A');
    await action.click();
    for (const id of ['ask', 'generate', 'create-spec', 'create-guide', 'create-notes', 'create-postmortem', 'create-custom']) {
      await expect(page.getByTestId(`assistant-action-${id}`)).toBeVisible();
    }
    // Rewrite and diagram actions require an article and belong in its dock,
    // not on the standalone AI route.
    await expect(page.getByTestId('assistant-action-diagram')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('shows an editable question composer with empty-send protection', async ({ page }) => {
    await page.goto('/ai');
    await expect(page.getByTestId('ask-input')).toBeEditable();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.getByTestId('ask-input').fill('First line');
    await page.getByTestId('ask-input').press('Shift+Enter');
    await page.getByTestId('ask-input').press('End');
    await page.getByTestId('ask-input').press('x');
    await expect(page.getByTestId('ask-input')).toHaveValue('First line\nx');
  });

  test('switches between question and generation composers', async ({ page }) => {
    await page.goto('/ai');
    await page.getByTestId('assistant-action-select').click();
    await page.getByTestId('assistant-action-generate').click();
    await expect(page.getByPlaceholder('Describe the page to generate...', { exact: true })).toBeEditable();
    await expect(page.getByTestId('ask-input')).toHaveCount(0);
    await page.getByTestId('assistant-action-select').click();
    await page.getByTestId('assistant-action-ask').click();
    await expect(page.getByTestId('ask-input')).toBeEditable();
    await expect(page.getByPlaceholder('Describe the page to generate...', { exact: true })).toHaveCount(0);
  });

  test('surfaces a failed LLM request and makes the composer usable again', async ({ page }) => {
    // Mock only the LLM-facing boundary. Auth, settings, conversations and
    // knowledge APIs still use the disposable backend.
    await page.route('**/api/ollama/models?usecase=chat', (route) => route.fulfill({
      json: [{ name: 'e2e-unavailable-model' }],
    }));
    await page.route('**/api/llm/ask', (route) => route.fulfill({
      status: 503,
      json: { error: 'Service Unavailable', message: 'E2E provider is unavailable', statusCode: 503 },
    }));
    await page.goto('/ai');
    await page.getByTestId('ask-input').fill('What is Compendiq?');
    const response = page.waitForResponse((res) => res.url().endsWith('/api/llm/ask') && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    expect((await response).status()).toBe(503);
    await expect(page.getByTestId('message-error')).toBeVisible();
    await expect(page.getByTestId('ai-error-announcer')).not.toBeEmpty();
    await expect(page.getByTestId('ask-input')).toBeEditable();
    await page.getByTestId('ask-input').fill('Try another question');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  });
});
