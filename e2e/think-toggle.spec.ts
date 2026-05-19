import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

/**
 * E2E: Think toggle wiring on the AI page.
 *
 * Proves end-to-end (UI → backend → upstream provider request body) that:
 *   1. Toggle OFF → no thinking-related fields on the upstream `/v1/chat/completions` body.
 *   2. Toggle ON  → `think: true` AND `chat_template_kwargs.enable_thinking: true`
 *      land on the upstream body (the open-model variant of `thinkingExtras()`).
 *
 * Setup: a host-side mock OpenAI server (started by the runner) captures every
 * upstream request body to a JSONL log. We register an admin, configure the
 * mock as the chat provider, drive the UI, then inspect the log.
 *
 * Serial mode: first-user-is-admin requires a single registration per run.
 */

const TEST_USER = `e2e_think_${Date.now()}`;
const TEST_PASS = 'TestPassword123!';

const LLM_URL = process.env.E2E_LLM_URL ?? 'http://host.docker.internal:11444/v1';
const MOCK_LOG = process.env.MOCK_REQ_LOG ?? '/tmp/think-mock-requests.jsonl';

function findAskCall(needle: string) {
  expect(existsSync(MOCK_LOG), `mock log exists at ${MOCK_LOG}`).toBeTruthy();
  const lines = readFileSync(MOCK_LOG, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .map((l) => JSON.parse(l).body as Record<string, unknown>)
    .find((b) =>
      b?.stream === true &&
      Array.isArray(b?.messages) &&
      (b.messages as Array<{ content?: string }>).some((m) => (m.content ?? '').includes(needle)),
    );
}

test.describe.configure({ mode: 'serial' });

test.describe('Think toggle wires upstream provider extras', () => {
  let accessToken: string;

  test.beforeAll(async ({ request }) => {
    const registerRes = await request.post(`${process.env.E2E_BASE_URL}/api/auth/register`, {
      data: { username: TEST_USER, password: TEST_PASS },
    });
    expect(registerRes.ok(), 'register first user as admin').toBeTruthy();
    const auth = await registerRes.json();
    expect(auth.user.role).toBe('admin');
    accessToken = auth.accessToken;

    // Configure mock as the chat + embedding provider via API (deterministic
    // — avoids racing async form rerenders in Settings → LLM).
    const createRes = await request.post(`${process.env.E2E_BASE_URL}/api/admin/llm-providers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        name: 'MockThink',
        baseUrl: LLM_URL,
        authType: 'none',
        verifySsl: true,
        defaultModel: 'qwen3:8b',
      },
    });
    expect(createRes.ok(), `create provider: ${createRes.status()}`).toBeTruthy();
    const provider = await createRes.json();

    const setDefaultRes = await request.post(
      `${process.env.E2E_BASE_URL}/api/admin/llm-providers/${provider.id}/set-default`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(setDefaultRes.ok()).toBeTruthy();

    const assignRes = await request.put(
      `${process.env.E2E_BASE_URL}/api/admin/llm-usecases`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: {
          chat:      { providerId: provider.id, model: 'qwen3:8b' },
          summary:   { providerId: provider.id, model: 'qwen3:8b' },
          quality:   { providerId: provider.id, model: 'qwen3:8b' },
          auto_tag:  { providerId: provider.id, model: 'qwen3:8b' },
          embedding: { providerId: provider.id, model: 'bge-m3' },
        },
      },
    );
    expect(assignRes.ok(), `assign usecases: ${assignRes.status()}`).toBeTruthy();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.evaluate((token) => {
      // The frontend store keeps `user` in localStorage too; a minimal
      // shape is enough to satisfy the gate.
      localStorage.setItem(
        'compendiq-auth',
        JSON.stringify({
          state: {
            accessToken: token,
            user: { username: 'e2e-think', role: 'admin' },
            isAuthenticated: true,
          },
          version: 0,
        }),
      );
    }, accessToken);
  });

  test('toggle OFF → no thinking extras on upstream body', async ({ page }) => {
    writeFileSync(MOCK_LOG, '');
    await page.goto('/ai');
    await expect(page.getByPlaceholder(/Ask a question/i)).toBeVisible({ timeout: 15_000 });

    // The input is sr-only; its parent <label> is the clickable surface.
    const thinkToggle = page.getByRole('checkbox', { name: 'Thinking mode' });
    if (await thinkToggle.isChecked()) await thinkToggle.uncheck({ force: true });
    await expect(thinkToggle).not.toBeChecked();

    const askInput = page.getByTestId('ask-input');
    const needle = `cap-no-think-${Date.now()}`;
    await askInput.fill(`Tell me about ${needle}`);
    await askInput.press('Enter');
    await expect(page.getByText('Mocked thinking response.')).toBeVisible({ timeout: 20_000 });

    const askCall = findAskCall(needle);
    expect(askCall, 'found the /llm/ask upstream request').toBeTruthy();
    expect(askCall!.think).toBeUndefined();
    expect(askCall!.chat_template_kwargs).toBeUndefined();
    expect(askCall!.reasoning_effort).toBeUndefined();
  });

  test('toggle ON → think + chat_template_kwargs land on upstream body', async ({ page }) => {
    writeFileSync(MOCK_LOG, '');
    await page.goto('/ai');
    await expect(page.getByPlaceholder(/Ask a question/i)).toBeVisible({ timeout: 15_000 });

    const thinkToggle = page.getByRole('checkbox', { name: 'Thinking mode' });
    // The input is sr-only — its label is the clickable surface, so the
    // direct click hits the wrapping <svg> instead. `force: true` lets
    // Playwright dispatch the click on the input itself.
    await thinkToggle.check({ force: true });
    await expect(thinkToggle).toBeChecked();

    const askInput = page.getByTestId('ask-input');
    const needle = `cap-with-think-${Date.now()}`;
    await askInput.fill(`Tell me about ${needle}`);
    await askInput.press('Enter');
    await expect(page.getByText('Mocked thinking response.')).toBeVisible({ timeout: 20_000 });

    const askCall = findAskCall(needle);
    expect(askCall, 'found the /llm/ask upstream request').toBeTruthy();
    expect(askCall!.think).toBe(true);
    expect(askCall!.chat_template_kwargs).toEqual({ enable_thinking: true });
    // For an open model (qwen3:8b), the OpenAI-only field must NOT be sent —
    // strict providers (OpenAI) reject unknown fields.
    expect(askCall!.reasoning_effort).toBeUndefined();
  });
});
