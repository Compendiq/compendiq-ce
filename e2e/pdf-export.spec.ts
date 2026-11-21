import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername, type E2eUser } from './helpers/auth';

test.describe('PDF export', () => {
  let session: E2eUser;
  test.beforeEach(async ({ page }) => {
    session = await registerUser(page.request, uniqueUsername('e2e_pdf'));
    await authenticateContext(page.context(), session);
  });

  async function createArticle(request: APIRequestContext, title: string): Promise<number> {
    const created = await request.post('/api/pages', {
      headers: bearerHeaders(session),
      data: {
        title,
        bodyHtml: '<h1>Test Article</h1><p>PDF export verification.</p><h2>Section One</h2><p>Section content.</p>',
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    return (await created.json()).id;
  }

  for (const surface of ['read toolbar', 'inspector rail'] as const) {
    test(`${surface} saves the named PDF or falls back to the page title`, async ({ page }, testInfo) => {
      // A laptop viewport starts with a collapsed inspector and exposes the rail action.
      await page.setViewportSize({ width: 1200, height: 900 });
      const titledPage = await createArticle(page.request, 'Установка v2');
      const emojiPage = await createArticle(page.request, '❤️');
      for (const [header, pageId, expectedName] of [
        ['from server', titledPage, 'установка-v2.pdf'],
        ['emoji title', emojiPage, `article-${emojiPage}.pdf`],
        ['missing', titledPage, '-v2.pdf'],
        ['malformed', titledPage, '-v2.pdf'],
        ['malformed language', titledPage, '-v2.pdf'],
      ] as const) {
        await page.goto(`/pages/${pageId}`);
        await expect(page.getByTestId('edit-page-btn')).toBeVisible();
        const endpoint = `/api/pages/${pageId}/export/pdf`;
        // Capture at the HTTP boundary: Chromium's DevTools response.body()
        // may be empty for an attachment even when the downloaded file is intact.
        let serverBytes: Buffer | undefined;
        await page.route(endpoint, async route => {
          const response = await route.fetch();
          serverBytes = await response.body();
          const headers = response.headers();
          if (header === 'missing') delete headers['content-disposition'];
          if (header === 'malformed') headers['content-disposition'] = "attachment; filename=wrong.pdf; filename*=UTF-8''bad%FF.pdf";
          if (header === 'malformed language') headers['content-disposition'] = "attachment; filename=plain.pdf; filename*=UTF-8'en-a'wrong.pdf";
          await route.fulfill({ response, headers, body: serverBytes });
        }, { times: 1 });

        const toolbar = surface === 'read toolbar';
        await page.getByTestId(toolbar ? 'article-read-more-btn' : 'article-actions-rail').click();
        const [download, response] = await Promise.all([
          page.waitForEvent('download'),
          page.waitForResponse(res => new URL(res.url()).pathname === endpoint),
          page.getByRole(toolbar ? 'menuitem' : 'button', { name: 'Export PDF', exact: true }).click(),
        ]);
        expect(response.status()).toBe(200);
        expect(download.suggestedFilename()).toBe(expectedName);
        const output = testInfo.outputPath(`${header}.pdf`);
        await download.saveAs(output);
        const bytes = await readFile(output);
        expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        expect(bytes).toEqual(serverBytes);
      }
    });
  }

  test('export page to PDF via API', async ({ page }) => {
    const pageId = await createArticle(page.request, 'Установка v2');
    const response = await page.request.post(`/api/pages/${pageId}/export/pdf`, {
      headers: bearerHeaders(session),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('application/pdf');
    expect((await response.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
