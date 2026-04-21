import { test, expect } from '@playwright/test';

/**
 * E2E: multi-LLM-provider flow
 *
 * Admin adds a provider via Settings → LLM, marks it default, assigns it to the
 * chat use-case, and sends a chat message that reaches the upstream LLM.
 *
 * Requires a reachable LLM endpoint. Set `E2E_LLM_URL` to override the default
 * (`http://localhost:11434/v1`). If no LLM backend is available the test is
 * skipped instead of marked failed.
 */

const E2E_LLM_URL = process.env.E2E_LLM_URL ?? 'http://localhost:11434/v1';
const TEST_USER = `e2e_llm_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

test.describe('Multi-LLM-provider flow', () => {
  test.beforeEach(async ({ page, request }) => {
    // Skip quickly if the LLM endpoint isn't reachable.
    try {
      const probe = await request.get(`${E2E_LLM_URL.replace(/\/v1\/?$/, '')}/api/tags`, {
        timeout: 2000,
      });
      if (!probe.ok()) test.skip(true, `LLM endpoint not reachable at ${E2E_LLM_URL}`);
    } catch {
      test.skip(true, `LLM endpoint not reachable at ${E2E_LLM_URL}`);
    }

    // Register the first admin user (first-user-is-admin). Re-running against a
    // DB that already has users will give us a non-admin account, so this test
    // is best run against a fresh database.
    const registerRes = await page.request.post('/api/auth/register', {
      data: { username: TEST_USER, password: TEST_PASS },
    });
    if (!registerRes.ok()) {
      test.skip(true, 'Could not register a test user');
      return;
    }
    const data = await registerRes.json();
    if (data.user.role !== 'admin') {
      test.skip(true, 'Test requires admin role (fresh DB so first user gets admin)');
      return;
    }

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

  test('admin adds a provider, sets as default, assigns to chat, chats succeed', async ({
    page,
  }) => {
    await page.goto('/settings/llm');

    await page.getByRole('button', { name: /\+ add/i }).click();
    await page.getByLabel(/name/i).fill('E2E');
    await page.getByLabel(/base url/i).fill(E2E_LLM_URL);
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('E2E')).toBeVisible();

    // The first newly-added provider is non-default — set it default.
    await page.getByRole('button', { name: /set default/i }).last().click();
    await expect(page.getByText(/default updated/i)).toBeVisible();

    // Assign to chat use case.
    await page.getByTestId('usecase-chat-provider').selectOption({ label: 'E2E' });
    await page.getByRole('button', { name: /save use-case assignments/i }).click();
    await expect(page.getByText(/use-case assignments saved/i)).toBeVisible();

    // Issue a chat request.
    await page.goto('/ai');
    await page.getByRole('textbox').first().fill('say hi');
    await page.getByRole('button', { name: /send/i }).click();
    await expect(page.locator('.message-assistant')).toBeVisible({ timeout: 30_000 });
  });
});
