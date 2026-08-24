import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  loginUser,
  openAuthenticatedPage,
  registerUser,
  uniqueUsername,
  type E2eUser,
} from './helpers/auth';
import {
  COLLAB_E2E_SKIP_NO_ADMIN,
  createStandalonePage,
  editor,
  enterCollabEdit,
  getCollabEnabled,
  setCollabEditingEnabled,
  typeInEditor,
} from './helpers/collab';

/**
 * Two-browser collaborative editing (#1449 / #1411 child 7).
 *
 * Isolated Playwright project `collab` (workers: 1). PUT collabEditingEnabled
 * only as admin; restore only if this worker turned the flag on. Chromium
 * ignores this file so the rest of the suite stays flag-off.
 *
 * Read-only prefix-drop is covered by `pages-collab.test.ts` (CE GET /pages/:id
 * 404s an admin on someone else's private page, so that UI path is not
 * exerciseable here).
 */

const STAMP = Date.now();
const PASS = E2E_PASSWORD;

let adminSession: E2eUser | null = null;
let enabledByThisWorker = false;

async function registerInNewContext(
  browser: Browser,
  prefix: string,
): Promise<{ context: BrowserContext; session: E2eUser }> {
  const context = await browser.newContext();
  const session = await registerUser(context.request, uniqueUsername(prefix), PASS);
  return { context, session };
}

async function resolveAdmin(browser: Browser): Promise<E2eUser | null> {
  const envUser = process.env.COLLAB_E2E_ADMIN;
  const envPass = process.env.COLLAB_E2E_PASSWORD;
  if (envUser && envPass) {
    const context = await browser.newContext();
    try {
      return await loginUser(context.request, envUser, envPass);
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext();
  try {
    const session = await registerUser(context.request, uniqueUsername('c7flag'), PASS);
    return session.user.role === 'admin' ? session : null;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

test.describe('Collaborative editing (#1449)', () => {
  test.beforeAll(async ({ browser }) => {
    const admin = await resolveAdmin(browser);
    if (!admin || admin.user.role !== 'admin') {
      test.skip(true, COLLAB_E2E_SKIP_NO_ADMIN);
      return;
    }
    adminSession = admin;

    const context = await browser.newContext();
    try {
      const alreadyOn = await getCollabEnabled(context.request, admin);
      if (!alreadyOn) {
        await setCollabEditingEnabled(context.request, admin, true);
        enabledByThisWorker = true;
      }
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!enabledByThisWorker || !adminSession) return;
    const context = await browser.newContext();
    try {
      await setCollabEditingEnabled(context.request, adminSession, false);
    } finally {
      await context.close();
    }
  });

  test('A types and B sees it; A caret is visible; Save from A does not 409 B', async ({
    browser,
  }) => {
    const a = await registerInNewContext(browser, 'c7a');
    const b = await registerInNewContext(browser, 'c7b');
    const marker = `sync-${STAMP}-alpha`;
    let pageA: Page | undefined;
    let pageB: Page | undefined;
    try {
      const created = await createStandalonePage(a.context.request, a.session, {
        title: `Collab E2E ${STAMP}`,
        bodyHtml: '<p>Alpha paragraph.</p><p>Beta paragraph.</p>',
        visibility: 'shared',
      });

      pageA = await openAuthenticatedPage(a.context, a.session, `/pages/${created.id}`);
      pageB = await openAuthenticatedPage(b.context, b.session, `/pages/${created.id}`);

      await enterCollabEdit(pageA);
      await enterCollabEdit(pageB);

      await typeInEditor(pageA, ` ${marker}`);
      await expect(editor(pageB)).toContainText(marker, { timeout: 10_000 });

      await editor(pageA).click();
      await pageA.keyboard.press('ArrowLeft');
      await expect(pageB.locator('.collaboration-carets__label')).toContainText(
        a.session.username,
        { timeout: 10_000 },
      );

      const aCommit = pageA.waitForResponse(
        (r) => r.url().includes('/collab/commit') && r.request().method() === 'POST',
      );
      await pageA.getByTestId('save-page-btn').click();
      expect((await aCommit).status(), 'Save from A must not 409').toBe(200);
      await expect(pageA.getByTestId('edit-page-btn')).toBeVisible({ timeout: 10_000 });

      await expect(editor(pageB)).toContainText(marker);
      const bCommit = pageB.waitForResponse(
        (r) => r.url().includes('/collab/commit') && r.request().method() === 'POST',
      );
      await pageB.getByTestId('save-page-btn').click();
      expect((await bCommit).status(), "B's subsequent Save must succeed").toBe(200);
    } finally {
      await pageA?.close();
      await pageB?.close();
      await a.context.close();
      await b.context.close();
    }
  });

  test('list and table edits converge across two sessions', async ({ browser }) => {
    const a = await registerInNewContext(browser, 'c7list');
    const b = await registerInNewContext(browser, 'c7listb');
    const item = `list-${STAMP}`;
    const cell = `cell-${STAMP}`;
    let pageA: Page | undefined;
    let pageB: Page | undefined;
    try {
      const created = await createStandalonePage(a.context.request, a.session, {
        title: `Collab list ${STAMP}`,
        bodyHtml:
          '<ul><li><p>Start item.</p></li></ul><table><tbody><tr><th><p>H</p></th></tr><tr><td><p>Cell</p></td></tr></tbody></table>',
        visibility: 'shared',
      });
      pageA = await openAuthenticatedPage(a.context, a.session, `/pages/${created.id}`);
      pageB = await openAuthenticatedPage(b.context, b.session, `/pages/${created.id}`);
      await enterCollabEdit(pageA);
      await enterCollabEdit(pageB);

      await expect(editor(pageB).locator('li')).toBeVisible({ timeout: 10_000 });
      await expect(editor(pageB).locator('table')).toBeVisible();

      await editor(pageA).locator('li').first().click();
      await pageA.keyboard.press('End');
      await pageA.keyboard.type(` ${item}`, { delay: 15 });
      await expect(editor(pageB).locator('li')).toContainText(item, { timeout: 10_000 });

      await editor(pageA).locator('td').first().click();
      await pageA.keyboard.press('End');
      await pageA.keyboard.type(` ${cell}`, { delay: 15 });
      await expect(editor(pageB).locator('td')).toContainText(cell, { timeout: 10_000 });
    } finally {
      await pageA?.close();
      await pageB?.close();
      await a.context.close();
      await b.context.close();
    }
  });
});
