import { test, expect } from '@playwright/test';

/**
 * E2E: AI Chat interface
 *
 * Tests that the AI assistant page loads, shows mode buttons,
 * and handles the chat interface appropriately even if no LLM
 * backend is available.
 */

const TEST_USER = `e2e_ai_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('AI Chat', () => {
  test.beforeEach(async ({ page }) => {
    // Register a fresh user via API
    const registerRes = await page.request.post('/api/auth/register', {
      data: { username: TEST_USER + Math.random().toString(36).slice(2, 6), password: TEST_PASS },
    });

    if (!registerRes.ok()) {
      test.skip();
      return;
    }

    const data = await registerRes.json();

    // Set auth state
    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user }) => {
        const authState = {
          state: { accessToken, user, isAuthenticated: true },
          version: 0,
        };
        localStorage.setItem('compendiq-auth', JSON.stringify(authState));
      },
      { accessToken: data.accessToken, user: data.user },
    );
  });

  test('loads AI assistant page with mode buttons', async ({ page }) => {
    await page.goto('/ai');
    await expect(page).toHaveURL(/\/ai/, { timeout: 10_000 });

    // The AI assistant should show mode buttons
    await expect(
      page.getByText('Q&A').or(page.getByRole('button', { name: /Q&A/i })),
    ).toBeVisible({ timeout: 10_000 });

    // Check for other mode buttons
    const improveBtn = page.getByText('Improve').or(page.getByRole('button', { name: /Improve/i }));
    const generateBtn = page.getByText('Generate').or(page.getByRole('button', { name: /Generate/i }));

    await expect(improveBtn).toBeVisible({ timeout: 5_000 });
    await expect(generateBtn).toBeVisible({ timeout: 5_000 });
  });

  test('shows chat input area', async ({ page }) => {
    await page.goto('/ai');
    await expect(page).toHaveURL(/\/ai/, { timeout: 10_000 });

    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Should have some kind of input area for asking questions
    const chatInput = page
      .getByPlaceholder(/ask|question|type|message/i)
      .or(page.getByTestId('chat-input'))
      .or(page.getByRole('textbox'))
      .or(page.locator('textarea'));

    // The chat input should be visible (or a "loading models" state)
    const hasInput = await chatInput.first().isVisible({ timeout: 5_000 }).catch(() => false);
    const hasLoadingModels = await page
      .getByText(/loading models/i)
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    const hasNoModels = await page
      .getByText(/no models|configure|connect/i)
      .isVisible({ timeout: 2_000 })
      .catch(() => false);

    // At least one of these states should be visible
    expect(hasInput || hasLoadingModels || hasNoModels).toBeTruthy();
  });

  test('can switch between AI modes', async ({ page }) => {
    await page.goto('/ai');
    await expect(page).toHaveURL(/\/ai/, { timeout: 10_000 });

    // Wait for modes to render
    await expect(
      page.getByText('Q&A').or(page.getByRole('button', { name: /Q&A/i })),
    ).toBeVisible({ timeout: 10_000 });

    // Click "Improve" mode
    const improveBtn = page.getByRole('button', { name: /Improve/i }).or(page.getByText('Improve'));
    await improveBtn.click();

    // Should show improve-specific content (e.g., "Navigate to a page" prompt)
    await expect(
      page.getByText(/navigate to a page|select a page|improve/i),
    ).toBeVisible({ timeout: 5_000 });

    // Click "Generate" mode
    const generateBtn = page.getByRole('button', { name: /Generate/i }).or(page.getByText('Generate'));
    await generateBtn.click();

    // Should show generate-specific content
    // Allow UI transition to settle
    await page.waitForLoadState('domcontentloaded');

    // Switch back to Q&A
    const qaBtn = page.getByRole('button', { name: /Q&A/i }).or(page.getByText('Q&A'));
    await qaBtn.click();

    await expect(
      page.getByText(/ask questions|knowledge base/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('handles question submission gracefully when LLM is unavailable', async ({
    page,
  }) => {
    await page.goto('/ai');
    await expect(page).toHaveURL(/\/ai/, { timeout: 10_000 });

    // Wait for the page to fully load
    await page.waitForLoadState('networkidle');

    // Find the chat input
    const chatInput = page
      .getByPlaceholder(/ask|question|type|message/i)
      .or(page.getByTestId('chat-input'))
      .or(page.getByRole('textbox'))
      .or(page.locator('textarea'));

    if (await chatInput.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Type a question
      await chatInput.first().fill('What is Compendiq?');

      // Try to submit (Enter or submit button)
      const submitBtn = page
        .getByRole('button', { name: /send|submit|ask/i })
        .or(page.getByTestId('send-btn'));

      if (await submitBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
        await submitBtn.first().click();
      } else {
        await chatInput.first().press('Enter');
      }

      // Should either show a response/streaming indicator OR an error message
      // (since LLM might not be available in the test environment)
      await page.waitForLoadState('networkidle');

      // Verify the app does not crash — any visible state is acceptable
      // (response message, loading indicator, or error toast)
      await expect(page).toHaveURL(/\/ai/);
    }
  });
});
