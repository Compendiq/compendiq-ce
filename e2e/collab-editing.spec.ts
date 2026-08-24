import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  openAuthenticatedPage,
  registerUser,
  uniqueUsername,
  type E2eUser,
} from './helpers/auth';
import {
  createStandalonePage,
  disableCollabFlag,
  editor,
  enterCollabEdit,
  ensureCollabEnabled,
  getCollabEnabled,
  typeInEditor,
} from './helpers/collab';

/**
 * Two-browser collaborative editing (#1449 / #1411 child 7).
 *
 * Enables `collabEditingEnabled` only for this file (PUT, or already-on) and
 * restores it afterwards so the rest of the suite stays flag-off. Uses two
 * `browser.newContext()` sessions, matching the pages-crud API-register pattern
 * plus the v1 persist payload (token stays on the refresh cookie).
 */

const STAMP = Date.now();
const PASS = E2E_PASSWORD;

let flagSession: E2eUser | null = null;
let flagWasAlreadyOn = false;

async function registerInNewContext(
  browser: Browser,
  prefix: string,
): Promise<{ context: BrowserContext; session: E2eUser }> {
  const context = await browser.newContext();
  const session = await registerUser(context.request, uniqueUsername(prefix), PASS);
  return { context, session };
}

test.describe('Collaborative editing (#1449)', () => {
  test.beforeAll(async ({ browser }) => {
    const { context, session } = await registerInNewContext(browser, 'c7flag');
    flagSession = session;
    try {
      flagWasAlreadyOn = await getCollabEnabled(context.request, session);
      await ensureCollabEnabled(context.request, session);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!flagSession || flagWasAlreadyOn) return;
    const context = await browser.newContext();
    try {
      await disableCollabFlag(context.request, flagSession);
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

  test('read-only session sees live updates and cannot commit', async ({ browser }) => {
    test.skip(
      !flagSession || flagSession.user.role !== 'admin',
      'Read-only collab needs an admin (first registered user) to view a private page',
    );
    const admin = flagSession!;

    const writer = await registerInNewContext(browser, 'c7own');
    const readerCtx = await browser.newContext();
    const login = await readerCtx.request.post('/api/auth/login', {
      data: { username: admin.username, password: PASS },
    });
    if (!login.ok()) {
      await writer.context.close();
      await readerCtx.close();
      throw new Error(`admin login failed: ${login.status()} ${await login.text()}`);
    }
    const marker = `ro-${STAMP}`;
    const rogue = `rogue-${STAMP}`;
    let pageW: Page | undefined;
    let pageR: Page | undefined;
    try {
      const created = await createStandalonePage(writer.context.request, writer.session, {
        title: `Collab private ${STAMP}`,
        bodyHtml: '<p>Private seed.</p>',
        visibility: 'private',
      });

      pageW = await openAuthenticatedPage(writer.context, writer.session, `/pages/${created.id}`);
      pageR = await openAuthenticatedPage(readerCtx, admin, `/pages/${created.id}`);
      await enterCollabEdit(pageW);
      await enterCollabEdit(pageR);

      await typeInEditor(pageW, ` ${marker}`);
      await expect(editor(pageR)).toContainText(marker, { timeout: 10_000 });

      await typeInEditor(pageR, ` ${rogue}`);
      // Prefix-drop is server-side; give the fan-out window a chance to leak.
      await pageW.waitForTimeout(2_000);
      expect(await editor(pageW).innerText()).not.toContain(rogue);

      const commit = pageR.waitForResponse(
        (r) => r.url().includes('/collab/commit') && r.request().method() === 'POST',
      );
      await pageR.getByTestId('save-page-btn').click();
      expect((await commit).status()).toBe(403);
    } finally {
      await pageW?.close();
      await pageR?.close();
      await writer.context.close();
      await readerCtx.close();
    }
  });
});
