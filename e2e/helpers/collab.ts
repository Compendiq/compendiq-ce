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

/**
 * Turn the collab flag on for this spec only. Prefers PUT /admin/settings
 * (first registered user is admin on a fresh DB). If the flag is already on
 * (operator / SQL pre-seed), PUT is skipped so a non-admin e2e user still works.
 */
export async function ensureCollabEnabled(
  request: APIRequestContext,
  session: E2eUser,
): Promise<void> {
  if (await getCollabEnabled(request, session)) return;

  const put = await request.put('/api/admin/settings', {
    headers: { ...bearerHeaders(session), 'Content-Type': 'application/json' },
    data: { collabEditingEnabled: true },
  });
  if (!put.ok()) {
    throw new Error(
      `Could not enable collabEditingEnabled (PUT ${put.status()} ${await put.text()}). ` +
        'This spec needs an admin session (first registered user) or the flag already on.',
    );
  }
  await expect
    .poll(async () => getCollabEnabled(request, session), { timeout: 10_000 })
    .toBe(true);
}

export async function disableCollabFlag(
  request: APIRequestContext,
  session: E2eUser,
): Promise<void> {
  const put = await request.put('/api/admin/settings', {
    headers: { ...bearerHeaders(session), 'Content-Type': 'application/json' },
    data: { collabEditingEnabled: false },
  });
  if (!put.ok()) return;
  await expect
    .poll(async () => getCollabEnabled(request, session), { timeout: 10_000 })
    .toBe(false);
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
