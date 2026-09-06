import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername, type E2eUser } from './helpers/auth';

test.describe('PDF export', () => {
  let session: E2eUser;
  let pageId: number;
  test.beforeEach(async ({ page }) => {
    session = await registerUser(page.request, uniqueUsername('e2e_pdf'));
    await authenticateContext(page.context(), session);
    const created = await page.request.post('/api/pages', {
      headers: bearerHeaders(session),
      data: {
        title: uniqueUsername('PDF Export'),
        bodyHtml: '<h1>Test Article</h1><p>PDF export verification.</p><h2>Section One</h2><p>Section content.</p>',
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    pageId = (await created.json()).id;
  });

  test('export page to PDF via the inspector', async ({ page }, testInfo) => {
    await page.goto(`/pages/${pageId}`);
    await expect(page.getByTestId('edit-page-btn')).toBeVisible();
    await page.getByRole('tab', { name: 'Details', exact: true }).click();
    await page.locator('summary').filter({ hasText: 'More actions' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const output = testInfo.outputPath('export.pdf');
    await download.saveAs(output);
    expect((await readFile(output)).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('export page to PDF via API', async ({ page }) => {
    const response = await page.request.post(`/api/pages/${pageId}/export/pdf`, {
      headers: bearerHeaders(session),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('application/pdf');
    expect((await response.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
