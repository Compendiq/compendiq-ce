import { test, expect } from '@playwright/test';
import {
  authenticateContext, bearerHeaders, registerUser, uniqueUsername, type E2eUser,
} from './helpers/auth';

/**
 * Browser coverage of the Confluence-facing connection, discovery and sync
 * boundary. External results are simulated at their browser API boundary;
 * this does not exercise the Node-side Confluence client or sync worker.
 * Authentication and ordinary settings GET/PUT use the real disposable stack.
 */
const CONFLUENCE_URL = 'https://confluence.mock.test';
const CONFLUENCE_PAT = 'FAKE-PAT-not-a-real-token';
const SPACES = [
  { key: 'CS-DEV', name: 'Engineering — Dev', type: 'global', pageCount: 6 },
  { key: 'CS-QA', name: 'Engineering — QA', type: 'global', pageCount: 4 },
];
const ASSET_COUNTS = { expected: 0, cached: 0, missing: 0 };

test.describe('Confluence sync flow (mocked external boundary)', () => {
  let session: E2eUser;

  test.beforeEach(async ({ context }) => {
    session = await registerUser(context.request, uniqueUsername('e2e_conf_mock'));
    expect(session.user.role).toBe('user');
    await authenticateContext(context, session);
  });

  test('tests credentials before saving them to the real settings API', async ({ page }) => {
    await page.route('**/api/settings/test-confluence', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ url: CONFLUENCE_URL, pat: CONFLUENCE_PAT });
      await route.fulfill({ json: { success: true, message: 'Connection successful' } });
    });
    await page.goto('/settings/personal/confluence');
    await page.getByLabel('Confluence URL', { exact: true }).fill(CONFLUENCE_URL);
    await page.getByLabel('Personal Access Token', { exact: true }).fill(CONFLUENCE_PAT);
    const save = page.getByTestId('confluence-save-btn');
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: 'Test Connection', exact: true }).click();
    await expect(page.getByTestId('confluence-test-result')).toHaveAttribute('data-state', 'success');
    await expect(save).toBeEnabled();
    // Editing a successfully tested pair must re-lock Save.
    await page.getByLabel('Confluence URL', { exact: true }).fill(`${CONFLUENCE_URL}/changed`);
    await expect(save).toBeDisabled();
    await page.getByLabel('Confluence URL', { exact: true }).fill(CONFLUENCE_URL);
    const saved = page.waitForResponse((res) => res.url().endsWith('/api/settings') && res.request().method() === 'PUT');
    await save.click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel('Confluence URL', { exact: true })).toHaveValue(CONFLUENCE_URL);
    await expect(page.locator('#confluence-pat')).toHaveValue('');
    await expect(page.locator('label[for="confluence-pat"]')).toContainText('Configured');
    const settings = await page.request.get('/api/settings', { headers: bearerHeaders(session) });
    expect(settings.ok()).toBe(true);
    const body = await settings.json();
    expect(body.hasConfluencePat).toBe(true);
    expect(body).not.toHaveProperty('confluencePat');
    expect(JSON.stringify(body)).not.toContain(CONFLUENCE_PAT);
  });

  test('fetches external spaces and lets the user select both', async ({ page }) => {
    await page.route('**/api/spaces/available', (route) => route.fulfill({ json: SPACES }));
    await page.goto('/settings/knowledge/spaces');
    await page.getByRole('button', { name: 'Fetch Spaces', exact: true }).click();
    for (const space of SPACES) {
      await page.getByRole('button', { name: `Select ${space.name}`, exact: true }).click();
      await expect(page.getByRole('button', { name: `Deselect ${space.name}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.getByRole('button', { name: 'Save Selection (2)', exact: true })).toBeEnabled();
    // Saving selections validates PAT visibility server-side; that is the
    // real Confluence spec's boundary, not something a browser mock can prove.
  });

  test('sync schedule shows imported space health and a triggered sync', async ({ page }) => {
    let syncing = false;
    await page.route('**/api/settings/sync-overview', (route) => route.fulfill({
      json: {
        sync: { userId: session.user.id, status: syncing ? 'syncing' : 'idle' },
        totals: {
          selectedSpaces: 2, totalPages: 10, pagesWithAssets: 0,
          pagesWithIssues: 0, healthyPages: 10, images: ASSET_COUNTS, drawio: ASSET_COUNTS,
        },
        spaces: SPACES.map((space) => ({
          spaceKey: space.key, spaceName: space.name, status: 'healthy',
          lastSynced: '2026-04-10T23:00:00.000Z', pageCount: space.pageCount,
          pagesWithAssets: 0, pagesWithIssues: 0, images: ASSET_COUNTS, drawio: ASSET_COUNTS,
        })),
        issues: [],
      },
    }));
    await page.route('**/api/sync', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      syncing = true;
      await route.fulfill({ status: 202, json: { message: 'Sync started' } });
    });
    await page.goto('/settings/knowledge/spaces');
    await page.getByRole('tab', { name: 'Sync schedule', exact: true }).click();
    for (const space of SPACES) {
      await expect(page.getByTestId(`sync-overview-space-${space.key}`)).toContainText(space.name);
    }
    await expect(page.getByTestId('sync-overview-empty')).toBeVisible();
    await page.getByTestId('sync-overview-sync-now').click();
    await expect(page.getByTestId('sync-overview-sync-now')).toHaveText('Syncing...');
    await expect(page.getByTestId('sync-overview-sync-now')).toBeDisabled();
  });
});
