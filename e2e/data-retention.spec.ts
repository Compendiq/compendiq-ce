import { test, expect, type APIRequestContext } from '@playwright/test';
import { authenticateContext, bearerHeaders, loginUser, type E2eUser } from './helpers/auth';

// #1875 — the CE-native retention windows on Data & Compliance → Retention.
// The Retention sub-tab is Enterprise UI and CE ships no licence, so the
// browser is granted ONLY the presentation entitlement by fulfilling
// GET /api/admin/license. Every /api/admin/settings read and write in this
// spec goes to the real backend and database.

interface RetentionWindows {
  webhook: number;
  denied: number;
}

async function readRetentionWindows(
  request: APIRequestContext,
  session: E2eUser,
): Promise<RetentionWindows> {
  const res = await request.get('/api/admin/settings', { headers: bearerHeaders(session) });
  if (!res.ok()) throw new Error(`GET /api/admin/settings ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as {
    webhookDeliveriesRetentionDays: number;
    adminAccessDeniedRetentionDays: number;
  };
  return { webhook: body.webhookDeliveriesRetentionDays, denied: body.adminAccessDeniedRetentionDays };
}

/** Restores the webhook window. A failed PUT throws — never swallow. */
async function putWebhookRetention(
  request: APIRequestContext,
  session: E2eUser,
  days: number,
): Promise<void> {
  const res = await request.put('/api/admin/settings', {
    headers: { ...bearerHeaders(session), 'Content-Type': 'application/json' },
    data: { webhookDeliveriesRetentionDays: days },
  });
  if (!res.ok()) {
    throw new Error(`PUT webhookDeliveriesRetentionDays=${days} failed: ${res.status()} ${await res.text()}`);
  }
}

test.describe('Data & Compliance → Retention windows', () => {
  let session: E2eUser | undefined;
  let original: RetentionWindows | undefined;

  test.beforeEach(async ({ context, page }) => {
    session = undefined;
    original = undefined;
    const username = process.env.COLLAB_E2E_ADMIN;
    const password = process.env.COLLAB_E2E_PASSWORD;
    if (!username || !password) throw new Error('Retention windows require COLLAB_E2E_ADMIN and COLLAB_E2E_PASSWORD');
    const admin = await loginUser(context.request, username, password);
    expect(admin.user.role).toBe('admin');
    await authenticateContext(context, admin);
    session = admin;
    original = await readRetentionWindows(context.request, admin);
    await page.route('**/api/admin/license', (route) => route.fulfill({
      json: { edition: 'enterprise', tier: 'enterprise', valid: true, features: ['data_retention_policies'] },
    }));
  });

  test.afterEach(async ({ context }) => {
    // Nothing to restore when beforeEach failed before reading the original.
    if (!session || !original) return;
    await putWebhookRetention(context.request, session, original.webhook);
  });

  test('blocks invalid values and saves only the webhook delivery window', async ({ context, page }) => {
    if (!session || !original) throw new Error('beforeEach did not establish the admin session');
    const admin = session;
    const before = original;
    const target = before.webhook === 120 ? 121 : 120;
    const putBodies: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/admin/settings') {
        putBodies.push(request.postDataJSON());
      }
    });

    await page.goto('/settings/governance/compliance');
    const input = page.getByLabel('Webhook delivery attempts retention (days)', { exact: true });
    const save = page.getByTestId('webhook-deliveries-retention-save-btn');
    await expect(input).toHaveValue(String(before.webhook));

    for (const invalid of ['6', '3651', '30.5', '']) {
      await input.fill(invalid);
      await input.press('Enter');
      await expect(page.getByText('Enter a whole number from 7 to 3650.', { exact: true })).toBeVisible();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(save).toHaveAttribute('aria-disabled', 'true');
    }
    expect(putBodies).toEqual([]);

    await input.fill(String(target));
    const saved = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/admin/settings');
    await input.press('Enter');
    expect((await saved).ok()).toBe(true);
    expect(putBodies).toEqual([{ webhookDeliveriesRetentionDays: target }]);

    await page.reload();
    await expect(input).toHaveValue(String(target));
    await expect(page.getByLabel('Admin access-denied audit retention (days)', { exact: true }))
      .toHaveValue(String(before.denied));
    expect(await readRetentionWindows(context.request, admin)).toEqual({
      webhook: target,
      denied: before.denied,
    });
  });
});
