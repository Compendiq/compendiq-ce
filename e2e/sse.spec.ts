import { test, expect } from '@playwright/test';
import { authenticateContext, registerUser, uniqueUsername } from './helpers/auth';

// The LLM-facing HTTP boundary is deterministic; the application's fetch/SSE
// parser, accumulated answer and terminal-state transition run in Chromium.
test('chat assembles SSE chunks and releases the composer on completion', async ({ page }) => {
  const session = await registerUser(page.request, uniqueUsername('e2e_sse'));
  await authenticateContext(page.context(), session);
  await page.route('**/api/ollama/models?usecase=chat', (route) => route.fulfill({
    json: [{ name: 'e2e-stream-model' }],
  }));
  await page.route('**/api/llm/ask', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'data: {"content":"The streamed"}\n\ndata: {"content":" answer arrived."}\n\ndata: {"done":true}\n\n',
  }));
  await page.goto('/ai');
  await page.getByTestId('ask-input').fill('Exercise streaming');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The streamed answer arrived.', { exact: true })).toBeVisible();
  await page.getByTestId('ask-input').fill('Another question');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});
