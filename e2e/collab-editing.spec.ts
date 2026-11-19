import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  bearerHeaders,
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
 * Isolated Playwright project `collab` (workers: 1, depends on chromium so
 * a full run keeps the flag off during the default suite). PUT
 * collabEditingEnabled only as admin; restore only if this worker turned
 * the flag on. Chromium ignores this file.
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
  } finally {
    await context.close();
  }
}

test.describe('Collaborative editing (#1449)', () => {
  test.beforeAll(async ({ browser }) => {
    const admin = await resolveAdmin(browser);
    if (process.env.E2E_CI === '1') {
      expect(admin?.user.role, 'CI must provision and supply the collab admin').toBe('admin');
    }
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
  test('a freeze over an open writer is refused, explained, and publishes nothing (#325)', async ({
    browser,
  }) => {
    // The freeze control needs an admin whose own session lives in this
    // browser context: auth is an httpOnly cookie set by the login response,
    // and the module-level admin session was logged in on a closed context.
    test.skip(!process.env.COLLAB_E2E_ADMIN || !process.env.COLLAB_E2E_PASSWORD,
      COLLAB_E2E_SKIP_NO_ADMIN);
    const a = await registerInNewContext(browser, 'c7freeze');
    const adminContext = await browser.newContext();
    const admin = await loginUser(
      adminContext.request,
      process.env.COLLAB_E2E_ADMIN!,
      process.env.COLLAB_E2E_PASSWORD!,
    );
    let pageA: Page | undefined;
    let pageAdmin: Page | undefined;
    let activationEnabled = false;
    try {
      // Freeze eligibility requires the acting user's Confluence integration
      // explicitly off; the CI admin starts with the product default on.
      const settings = await adminContext.request.put('/api/settings', {
        headers: bearerHeaders(admin),
        data: { confluenceEnabled: false },
      });
      expect(settings.ok(), await settings.text()).toBe(true);

      // The page-detail capability only offers freeze once creation is active;
      // a freshly booted backend reports its protected writers as ready.
      const activation = await adminContext.request.put('/api/admin/page-baselines/activation', {
        headers: bearerHeaders(admin),
        data: { creationEnabled: true },
      });
      expect(activation.ok(), await activation.text()).toBe(true);
      activationEnabled = true;

      const created = await createStandalonePage(a.context.request, a.session, {
        title: `Collab freeze ${STAMP}`,
        bodyHtml: '<p>Saving this paragraph can wait.</p>',
        visibility: 'shared',
      });

      pageA = await openAuthenticatedPage(a.context, a.session, `/pages/${created.id}`);
      await enterCollabEdit(pageA);
      const typed = `unsaved-${STAMP}`;
      await typeInEditor(pageA, ` ${typed}`);

      // The second user is the admin who would freeze it. The inspector's
      // Document lifecycle block is collapsed by default; open it the way a
      // reader does, then take the freeze control.
      pageAdmin = await openAuthenticatedPage(adminContext, admin, `/pages/${created.id}`);
      const lifecycle = pageAdmin.getByTestId('document-lifecycle');
      await expect(lifecycle).toBeVisible({ timeout: 15_000 });
      if (!(await lifecycle.evaluate((el) => (el as HTMLDetailsElement).open))) {
        await lifecycle.locator('summary').click();
      }
      await pageAdmin.getByTestId('freeze-btn').click();

      // The writable room admission is the blocker, and the shared client
      // explains the one action that clears it. Nothing was frozen.
      await expect(pageAdmin.getByTestId('freeze-preview-error')).toContainText(
        'Someone is editing this article right now. Ask them to save and close, then try again.',
        { timeout: 15_000 },
      );
      await pageAdmin.getByTestId('freeze-cancel').click();
      await expect(pageAdmin.getByTestId('freeze-btn')).toBeVisible();
      await expect(pageAdmin.getByTestId('unfreeze-btn')).toHaveCount(0);

      // The open session kept writing: a refused freeze is not a demotion and
      // the typed text is still there.
      await expect(pageA.getByText('This editing session is now read-only')).toHaveCount(0);
      await expect(editor(pageA)).toContainText(typed);
      await typeInEditor(pageA, ` after-${STAMP}`);
      await expect(editor(pageA)).toContainText(`after-${STAMP}`);
    } finally {
      await pageA?.close();
      await pageAdmin?.close();
      if (activationEnabled) {
        const disabled = await adminContext.request.put('/api/admin/page-baselines/activation', {
          headers: bearerHeaders(admin),
          data: { creationEnabled: false },
        });
        expect(disabled.ok(), await disabled.text()).toBe(true);
      }
      await a.context.close();
      await adminContext.close();
    }
  });

});
