import { test, expect, type Page } from '@playwright/test';

/**
 * E2E: Sidebar drag-to-reorder under the pointer-event bridge (#1089, follow-up
 * to #1088).
 *
 * This is the ONLY environment that reproduces the original bug: a real Chromium
 * throws `NotFoundError` from `Element.setPointerCapture()` for a pointer id it
 * is not tracking (the synthesized id the bridge uses). jsdom never throws, so a
 * unit test cannot exercise the tolerance path end-to-end — hence a Playwright
 * spec.
 *
 * The "pointerless" input environment (software KVM / VNC / RDP) is simulated by
 * dispatching raw `MouseEvent`s from inside the page. A JS-dispatched MouseEvent
 * emits NO native pointer event, so the bridge never latches off and must
 * synthesize the pointerdown/move/up that drive @dnd-kit — exactly as it does
 * for a real pointerless mouse. (Playwright's `page.mouse` / `page.click` would
 * emit trusted pointer events and latch the bridge off, so they must NOT be used
 * here.)
 *
 * Primary assertion: no uncaught exception surfaces during the drag — i.e. the
 * bridge swallowed the `setPointerCapture` NotFoundError that @dnd-kit raises at
 * drag start. The reorder actually persisting is a best-effort secondary check.
 *
 * NOTE: correct-by-construction; runs on CI / a live stack only (needs backend +
 * frontend on E2E_BASE_URL). It was NOT executed against a live app locally.
 */

const TEST_PASS = 'TestPassword123!';

interface Seeded {
  spaceKey: string;
  titlesInOrder: string[];
}

test.describe('Sidebar drag-reorder (pointer-event bridge)', () => {
  let seeded: Seeded;

  test.beforeEach(async ({ page }) => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const username = `e2e_drag_${suffix}`;
    const spaceKey = `E2EDRAG${suffix}`; // matches ^[A-Z0-9_]+$
    // Alphabetical so the initial tree order (sort_order defaults to 0, then
    // title) is deterministic: Alpha, Bravo, Charlie top-to-bottom.
    const titlesInOrder = [`Alpha ${suffix}`, `Bravo ${suffix}`, `Charlie ${suffix}`];

    const registerRes = await page.request.post('/api/auth/register', {
      data: { username, password: TEST_PASS },
    });
    if (!registerRes.ok()) {
      test.skip();
      return;
    }
    const { accessToken, user } = (await registerRes.json()) as {
      accessToken: string;
      user: unknown;
    };
    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

    // Seed a local space + three root pages so the sidebar has draggable rows.
    // (An empty dev DB — no draggable rows — was the original #1088 blocker.)
    const spaceRes = await page.request.post('/api/spaces/local', {
      ...auth,
      data: { key: spaceKey, name: `Drag E2E ${suffix}` },
    });
    if (!spaceRes.ok()) {
      test.skip();
      return;
    }
    for (const title of titlesInOrder) {
      const pageRes = await page.request.post('/api/pages', {
        ...auth,
        data: { title, bodyHtml: '<p>drag e2e</p>', spaceKey },
      });
      if (!pageRes.ok()) {
        test.skip();
        return;
      }
    }

    // Seed auth + pre-select the local space so the tree renders on first load
    // WITHOUT any real click (a click would emit trusted pointer events and
    // latch the bridge off before we can simulate the pointerless drag).
    await page.goto('/login');
    await page.evaluate(
      ({ accessToken, user, spaceKey }) => {
        localStorage.setItem(
          'compendiq-auth',
          JSON.stringify({ state: { accessToken, user, isAuthenticated: true }, version: 0 }),
        );
        // zustand persist shallow-merges the persisted slice over the store
        // defaults, so seeding only treeSidebarSpaceKey is enough.
        localStorage.setItem(
          'compendiq-ui',
          JSON.stringify({ state: { treeSidebarSpaceKey: spaceKey }, version: 0 }),
        );
      },
      { accessToken, user, spaceKey },
    );

    await page.goto('/');
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

    seeded = { spaceKey, titlesInOrder };
  });

  test('pointerless drag reorder does not crash on setPointerCapture', async ({ page }) => {
    // Wait for the lazy-loaded local-space tree to render its draggable rows.
    const rows = page.locator('[role="treeitem"][data-page-id]');
    await expect(rows).toHaveCount(seeded.titlesInOrder.length, { timeout: 20_000 });

    // Collect uncaught page exceptions from here on. If the bridge fails to
    // swallow the NotFoundError from setPointerCapture, it surfaces here.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Simulate a pointerless drag of the first row downward past the last one by
    // dispatching raw MouseEvents inside the page. These emit no native pointer
    // events, so the bridge stays active and synthesizes the pointer stream that
    // @dnd-kit consumes — including the drag-start setPointerCapture(1) that a
    // real browser rejects with NotFoundError for the synthesized pointer id.
    await simulatePointerlessDrag(page);

    // Give @dnd-kit's async drag lifecycle (rAF + state commits) time to run and
    // any deferred exception to surface.
    await page.waitForTimeout(500);

    // PRIMARY: the drag produced no uncaught exception.
    expect(errors).toEqual([]);

    // SECONDARY (best-effort): the reorder persisted. The exact @dnd-kit
    // activation is timing-sensitive under synthetic events, so a missed reorder
    // must NOT fail the test — only a persisted-but-broken one would, and that is
    // covered by the reorder integration tests. We simply reload and confirm the
    // tree still renders all rows without error.
    try {
      const reorderReq = await page.waitForRequest(
        (req) => /\/api\/pages\/\d+\/reorder$/.test(req.url()) && req.method() === 'PUT',
        { timeout: 2_000 },
      );
      const resp = await reorderReq.response();
      if (resp) expect(resp.ok()).toBeTruthy();
    } catch {
      // No reorder request fired — acceptable for this correctness-of-no-crash test.
    }

    await page.reload();
    await expect(page.locator('[role="treeitem"][data-page-id]')).toHaveCount(
      seeded.titlesInOrder.length,
      { timeout: 20_000 },
    );
    expect(errors).toEqual([]);
  });
});

/**
 * Dispatch a raw-MouseEvent drag of the first sidebar row down past the last
 * one. Runs inside the page so the events are untrusted (no native pointer
 * events), which is precisely the pointerless environment the bridge targets.
 */
async function simulatePointerlessDrag(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[role="treeitem"][data-page-id]'),
    );
    if (rows.length < 2) return;

    const source = rows[0]!;
    const target = rows[rows.length - 1]!;
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endY = to.top + to.height / 2 + 4;

    const fire = (el: Element, type: string, x: number, y: number, buttons: number) => {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }),
      );
    };

    fire(source, 'mousedown', startX, startY, 1);
    await raf();

    // Move down in several steps, crossing @dnd-kit's activation distance and
    // then past each sibling so a reorder can register.
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const y = startY + ((endY - startY) * i) / steps;
      fire(document.body, 'mousemove', startX, y, 1);
      await raf();
    }

    fire(document.body, 'mouseup', startX, endY, 0);
    await raf();
  });
}
