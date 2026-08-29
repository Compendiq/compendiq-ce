import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  bearerHeaders,
  openAuthenticatedPage,
  registerUser,
  uniqueUsername,
  type E2eUser,
} from './helpers/auth';

/**
 * Library browse-empty state in a real browser (#1402 phase 3 / PR #1508).
 *
 * Phase 3 split the Library's browse-empty state into three cases and the jsdom
 * suite mutation-tests all three. What it could not do is exercise them in a
 * browser: reaching the empty state needs a user with zero accessible pages,
 * which a populated database only provides destructively. A FRESHLY REGISTERED
 * user has no space assignments and no local pages, so their Library is
 * genuinely empty — the same clean slate the rest of this suite relies on, and
 * it depends on nothing already in the database.
 *
 * Every assertion is scoped INSIDE `[data-testid="empty-state"]`. That is not
 * tidiness: the phase-2 Getting Started checklist renders on this same route
 * and carries its own "Connect …" and "Choose spaces" controls, so a page-wide
 * query for either CTA passes with the empty state uninvolved.
 *
 * Serial, and both users are registered once in `beforeAll`: `POST
 * /api/auth/register` shares the `auth` rate-limit bucket (5/min by default),
 * so a per-test registration across parallel workers 429s rather than testing
 * anything. Two users, because "no PAT" and "PAT with no spaces" are two
 * account states, and switching one account back and forth would make the
 * cases order-dependent.
 */

test.describe.configure({ mode: 'serial' });

const EMPTY_STATE = '[data-testid="empty-state"]';
const CONFLUENCE_SETTINGS_PATH = '/settings/personal/confluence';
const SPACES_SETTINGS_PATH = '/settings/knowledge/spaces';

/** Null until `beforeAll` proves registration works; `beforeEach` skips on that. */
let noPat: { context: BrowserContext; session: E2eUser } | null = null;
let patNoSpaces: { context: BrowserContext; session: E2eUser } | null = null;

async function libraryFor(
  account: { context: BrowserContext; session: E2eUser } | null,
  path = '/',
): Promise<{ page: Page; empty: Locator }> {
  const { context, session } = account!;
  const page = await openAuthenticatedPage(context, session, path);
  const empty = page.locator(EMPTY_STATE);
  // Scoping only means something if there is exactly one of these on the
  // route, so assert that rather than silently taking `.first()`.
  await expect(empty).toHaveCount(1);
  return { page, empty };
}

test.describe('Library empty state (#1402 phase 3)', () => {
  test.beforeAll(async ({ browser }) => {
    // Probe first: an instance with self-registration closed (403
    // `registration_disabled`) cannot host this spec at all, and that is a
    // skip with a reason, never a failure.
    const probeContext = await browser.newContext();
    try {
      const probe = await probeContext.request.post('/api/auth/register', {
        data: { username: uniqueUsername('e2e_emptystate_probe'), password: E2E_PASSWORD },
      });
      if (!probe.ok()) return;
    } finally {
      await probeContext.close();
    }

    const aContext = await browser.newContext();
    noPat = {
      context: aContext,
      session: await registerUser(aContext.request, uniqueUsername('e2e_emptystate'), E2E_PASSWORD),
    };

    const bContext = await browser.newContext();
    const bSession = await registerUser(
      bContext.request,
      uniqueUsername('e2e_emptystate_pat'),
      E2E_PASSWORD,
    );
    // `PUT /api/settings` stores the PAT encrypted and does NOT probe
    // Confluence (that is `POST /api/settings/test-confluence`), so a dummy
    // string is enough to flip `hasConfluencePat`. `confluenceUrl` is optional
    // in `UpdateSettingsSchema` and this branch reads only `hasConfluencePat`
    // and `selectedSpaces`, so it is left unset. An empty `selectedSpaces`
    // skips the #815 PAT-visibility guard, which gates only the INSERT path.
    const res = await bContext.request.put('/api/settings', {
      headers: bearerHeaders(bSession),
      data: { confluencePat: 'e2e-dummy-pat-not-a-real-credential', selectedSpaces: [] },
    });
    expect(res.ok(), `PUT /api/settings failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    patNoSpaces = { context: bContext, session: bSession };
  });

  test.afterAll(async () => {
    await noPat?.context.close();
    await patNoSpaces?.context.close();
    noPat = null;
    patNoSpaces = null;
  });

  test.beforeEach(() => {
    test.skip(!noPat, 'Registration is unavailable in this E2E environment');
  });

  // Case A — no PAT, no spaces: the state every new user lands in.
  test('asks a user with no PAT to connect Confluence, and goes there', async () => {
    const { page, empty } = await libraryFor(noPat);

    await expect(empty.getByTestId('empty-state-title')).toHaveText(
      'No Confluence spaces connected',
    );

    const cta = empty.getByRole('button', { name: 'Connect Confluence' });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(new RegExp(`${CONFLUENCE_SETTINGS_PATH}$`));
  });

  // Case B — PAT set, zero spaces. Ruling 1 of the phase-3 review, and the
  // case with the highest regression value: the naive implementation showed
  // Case A's copy here and dead-ended the user on a panel already completed.
  test('asks a connected user with no spaces to choose spaces, and goes there', async () => {
    const { page, empty } = await libraryFor(patNoSpaces);

    await expect(empty.getByTestId('empty-state-title')).toHaveText('No spaces selected');

    const cta = empty.getByRole('button', { name: 'Choose spaces' });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(new RegExp(`${SPACES_SETTINGS_PATH}$`));
  });

  // Case C — Ruling 2, the single-accent rule. Both setup prompts pass
  // `actionTone="secondary"`, because the checklist one block above asks for
  // the same setup and the header's `New Page` is this route's own primary
  // action. Asserted on the CLASS, since that is what the ruling is about.
  test('keeps both setup prompts off the filled accent', async () => {
    const a = await libraryFor(noPat);
    await expect(a.empty.getByTestId('empty-state-title')).toHaveText(
      'No Confluence spaces connected',
    );
    await expect(a.empty.locator('button.nm-button-primary')).toHaveCount(0);
    await expect(a.empty.locator('button.nm-button-secondary').first()).toBeVisible();

    const b = await libraryFor(patNoSpaces);
    await expect(b.empty.getByTestId('empty-state-title')).toHaveText('No spaces selected');
    await expect(b.empty.locator('button.nm-button-primary')).toHaveCount(0);
    await expect(b.empty.locator('button.nm-button-secondary').first()).toBeVisible();
  });

  // Case D — the negative that keeps the two branches honest: a query that
  // matched nothing must never be blamed on an unconnected Confluence. Both
  // new branches require an UNFILTERED empty list, and this pins that gate.
  // `mode=keyword` because the default `hybrid` mode routes a query to the
  // semantic-results block, which has an empty state of its own.
  test('blames the search term, not Confluence, when a query matches nothing', async () => {
    const { empty } = await libraryFor(noPat, '/?mode=keyword&search=zzz-no-such-page-zzz');

    const title = empty.getByTestId('empty-state-title');
    await expect(title).toHaveText('No pages found');
    await expect(title).not.toHaveText('No Confluence spaces connected');
    await expect(title).not.toHaveText('No spaces selected');
  });
});
