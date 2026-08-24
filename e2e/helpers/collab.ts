import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { bearerHeaders, type E2eUser } from './auth';

export async function getCollabEnabled(
  request: APIRequestContext,
  session: E2eUser,
): Promise<boolean> {
  const res = await request.get('/api/collab/config', {
    headers: bearerHeaders(session),
  });
  if (!res.ok()) {
    throw new Error(`GET /api/collab/config ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { enabled?: boolean };
  return body.enabled === true;
}

export const COLLAB_E2E_SKIP_NO_ADMIN =
  'Collab e2e needs an admin to PUT collabEditingEnabled. Use an empty DB (first register is admin) or set COLLAB_E2E_ADMIN and COLLAB_E2E_PASSWORD.';

/** PUT the flag. Caller must be admin. A failed PUT throws — never swallow. */
export async function setCollabEditingEnabled(
  request: APIRequestContext,
  session: E2eUser,
  enabled: boolean,
): Promise<void> {
  const put = await request.put('/api/admin/settings', {
    headers: { ...bearerHeaders(session), 'Content-Type': 'application/json' },
    data: { collabEditingEnabled: enabled },
  });
  if (!put.ok()) {
    throw new Error(
      `PUT /admin/settings collabEditingEnabled=${enabled} failed: ${put.status()} ${await put.text()}`,
    );
  }
  await expect
    .poll(async () => getCollabEnabled(request, session), { timeout: 10_000 })
    .toBe(enabled);
}

export async function createStandalonePage(
  request: APIRequestContext,
  session: E2eUser,
  opts: { title: string; bodyHtml: string; visibility?: 'private' | 'shared' },
): Promise<{ id: number; title: string }> {
  const res = await request.post('/api/pages', {
    headers: bearerHeaders(session),
    data: {
      title: opts.title,
      bodyHtml: opts.bodyHtml,
      visibility: opts.visibility ?? 'shared',
      source: 'standalone',
    },
  });
  if (!res.ok()) {
    throw new Error(`POST /api/pages ${res.status()} ${await res.text()}`);
  }
  const created = (await res.json()) as { id: number | string; title: string };
  return { id: Number(created.id), title: created.title };
}

export async function enterCollabEdit(page: Page): Promise<void> {
  await page.getByTestId('edit-page-btn').click();
  await expect(page.getByTestId('collab-connecting')).toHaveCount(0, { timeout: 20_000 });
  const joinError = page.getByTestId('collab-join-error');
  if (await joinError.isVisible().catch(() => false)) {
    throw new Error(`collab join failed: ${await joinError.innerText()}`);
  }
  await expect(page.locator('[data-collab="on"] .tiptap')).toBeVisible({ timeout: 15_000 });
}

export function editor(page: Page) {
  return page.locator('[data-collab="on"] .tiptap');
}

export async function typeInEditor(page: Page, text: string): Promise<void> {
  const el = editor(page);
  await el.click();
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 15 });
}
