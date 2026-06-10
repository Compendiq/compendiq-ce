/**
 * Integration tests for deletion reconciliation (#706) and its #766 follow-ups:
 * the revival cross-check (a page live upstream again — e.g. restored from the
 * Confluence trash — gets its local soft-delete cleared, guarded by a grace
 * window so an in-flight delete-route intent is never resurrected) and the
 * purge upstream gone-confirmation (purge is irreversible, so candidates are
 * re-confirmed 404/trashed before the local hard-delete).
 *
 * `detectDeletedPages` soft-deletes local rows for pages that were removed in
 * Confluence. These tests exercise the real PostgreSQL `pages` table via
 * `test-db-helper.ts` and stub only the `ConfluenceClient`, so the live-id
 * listing + per-candidate 404 confirmation logic is validated against actual
 * soft-delete behaviour. They `describe.skipIf(!dbAvailable)` so contributors
 * without a running test Postgres can still run the rest of the suite.
 *
 * We drive the reconciler directly via the module's `__internal.detectDeletedPages`
 * export rather than through `syncUser` — going through the full sync walk would
 * require stubbing half a dozen unrelated collaborators and obscures what we are
 * actually asserting (which local rows get soft-deleted, and which are spared).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { ConfluenceError } from './confluence-client.js';

const { __internal } = await import('./sync-service.js');
const { detectDeletedPages, purgeDeletedPages } = __internal;

const dbAvailable = await isDbAvailable();

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Minimal ConfluenceClient stub for the reconciler. `getAllPageIds` returns the
 * authoritative live set for the space; `getPage` resolves for ids the caller
 * configures as "still present" (200 `status: 'current'`), resolves with
 * `status: 'trashed'` for ids configured as trashed (#766 — DC's DELETE trashes
 * rather than purges, and some DC versions still serve trashed content on a
 * direct GET), and rejects with a 404 ConfluenceError for ids configured as
 * "gone". Any id not in those sets rejects with the supplied error (used to
 * exercise the "inconclusive — do not delete" branch with a 403/5xx).
 */
function makeClient(opts: {
  liveIds: string[];
  presentForGetPage?: string[];
  trashedForGetPage?: string[];
  goneForGetPage?: string[];
  getPageError?: (id: string) => Error;
  failListing?: boolean;
}) {
  const present = new Set(opts.presentForGetPage ?? []);
  const trashed = new Set(opts.trashedForGetPage ?? []);
  const gone = new Set(opts.goneForGetPage ?? []);
  const getPageCalls: string[] = [];
  return {
    getPageCalls,
    async getAllPageIds(_spaceKey: string): Promise<Set<string>> {
      if (opts.failListing) throw new Error('listing failed');
      return new Set(opts.liveIds);
    },
    async getPage(id: string): Promise<unknown> {
      getPageCalls.push(id);
      if (gone.has(id)) throw new ConfluenceError('Resource not found', 404);
      if (trashed.has(id)) return { id, status: 'trashed' };
      if (present.has(id)) return { id, status: 'current' };
      if (opts.getPageError) throw opts.getPageError(id);
      // Default: treat as present so an unconfigured id is never deleted.
      return { id, status: 'current' };
    },
  };
}

async function insertPage(confluenceId: string, spaceKey: string): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                         body_storage, body_html, inherit_perms)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '', TRUE)
     RETURNING id`,
    [confluenceId, spaceKey, `Page ${confluenceId}`],
  );
  return res.rows[0]!.id;
}

async function getDeletedAt(confluenceId: string): Promise<Date | null> {
  const res = await query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM pages WHERE confluence_id = $1',
    [confluenceId],
  );
  return res.rows[0]?.deleted_at ?? null;
}

/** Backdate a row's soft-delete by `seconds` (0 = soft-deleted right now). */
async function softDelete(confluenceId: string, seconds = 0): Promise<void> {
  await query(
    'UPDATE pages SET deleted_at = NOW() - make_interval(secs => $2) WHERE confluence_id = $1',
    [confluenceId, seconds],
  );
}

async function rowExists(confluenceId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM pages WHERE confluence_id = $1', [confluenceId]);
  return (res.rowCount ?? 0) > 0;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('sync-service deletion reconciliation (#706)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('soft-deletes a page confirmed gone in Confluence (404) and keeps live pages', async () => {
    await insertPage('keep-1', 'DEV'); // still in Confluence
    await insertPage('gone-1', 'DEV'); // removed in Confluence

    const client = makeClient({
      liveIds: ['keep-1'], // gone-1 absent from the live listing
      goneForGetPage: ['gone-1'], // confirmed 404 on direct fetch
    });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(await getDeletedAt('gone-1')).not.toBeNull();
    expect(await getDeletedAt('keep-1')).toBeNull();
    expect(counts.pagesDeleted).toBe(1);
    // The reconciler only confirms candidates absent from the live set.
    expect(client.getPageCalls).toEqual(['gone-1']);
  });

  it('soft-deletes a page Confluence reports as trashed (200, not 404) — #766', async () => {
    // Confluence DC's DELETE on a current page moves it to the space trash; on
    // some DC versions a direct GET then answers 200 {status:'trashed'} rather
    // than 404. The reconciler must treat that as deleted, otherwise pages
    // removed via Compendiq's own Delete button are never converged.
    await insertPage('keep-2', 'DEV');
    await insertPage('trashed-1', 'DEV');

    const client = makeClient({
      liveIds: ['keep-2'], // trashed content is absent from the live listing
      trashedForGetPage: ['trashed-1'], // direct GET answers 200 {status:'trashed'}
    });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(await getDeletedAt('trashed-1')).not.toBeNull();
    expect(await getDeletedAt('keep-2')).toBeNull();
    expect(counts.pagesDeleted).toBe(1);
    expect(client.getPageCalls).toEqual(['trashed-1']);
  });

  it('does NOT delete a page absent from this view but still present remotely (shared-space safety)', async () => {
    // The page is missing from THIS principal's listing (e.g. restricted), but a
    // direct fetch returns 200 — another user can still see it. Must NOT delete.
    await insertPage('restricted-1', 'SHARED');

    const client = makeClient({
      liveIds: [], // absent from this principal's listing
      presentForGetPage: ['restricted-1'], // but the direct fetch finds it (200)
    });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'SHARED', counts);

    expect(await getDeletedAt('restricted-1')).toBeNull();
    expect(counts.pagesDeleted).toBe(0);
    expect(client.getPageCalls).toEqual(['restricted-1']);
  });

  it('does NOT delete on an inconclusive (403/5xx) confirmation fetch', async () => {
    await insertPage('forbidden-1', 'SHARED');

    const client = makeClient({
      liveIds: [],
      getPageError: () => new ConfluenceError('Insufficient permissions', 403),
    });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'SHARED', counts);

    expect(await getDeletedAt('forbidden-1')).toBeNull();
    expect(counts.pagesDeleted).toBe(0);
  });

  it('skips reconciliation entirely when the live-id listing fails (no deletes)', async () => {
    await insertPage('orphan-1', 'DEV');

    const client = makeClient({ liveIds: [], failListing: true });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(await getDeletedAt('orphan-1')).toBeNull();
    expect(counts.pagesDeleted).toBe(0);
    // No confirmation fetches when we couldn't even establish the live set.
    expect(client.getPageCalls).toEqual([]);
  });

  it('ignores already soft-deleted rows (no double-processing)', async () => {
    const id = await insertPage('already-gone', 'DEV');
    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [id]);

    const client = makeClient({ liveIds: [], goneForGetPage: ['already-gone'] });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    // The row was already soft-deleted; it is not a candidate, so no confirmation
    // fetch is issued and the counter does not move.
    expect(counts.pagesDeleted).toBe(0);
    expect(client.getPageCalls).toEqual([]);
  });

  it('reconciles in a shared space (multiple users), no longer gated to single-user spaces', async () => {
    // Two users own the SHARED space — the old single-user-space guard would have
    // bailed here. The new per-candidate 404 confirmation reconciles regardless.
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES (gen_random_uuid(), 'u1', 'u1@test', 'user', 'x'),
              (gen_random_uuid(), 'u2', 'u2@test', 'user', 'x')`,
    );
    await insertPage('shared-gone', 'SHARED');

    const client = makeClient({ liveIds: [], goneForGetPage: ['shared-gone'] });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'SHARED', counts);

    expect(await getDeletedAt('shared-gone')).not.toBeNull();
    expect(counts.pagesDeleted).toBe(1);
  });

  it('defers the WHOLE run (zero soft-deletes) when candidates exceed MAX_DELETION_CONFIRMATIONS=200', async () => {
    // 201 local rows, none present in the live listing — e.g. a permission change
    // suddenly hid a large subtree from this principal. The cap must trip BEFORE any
    // confirmation fetch so we neither hammer Confluence nor risk a mass false delete.
    const ids = Array.from({ length: 201 }, (_, i) => `cap-${i}`);
    for (const id of ids) await insertPage(id, 'DEV');

    // Even though every candidate would confirm as a 404, the cap defers first.
    const client = makeClient({ liveIds: [], goneForGetPage: ids });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    // No confirmation fetches and nothing soft-deleted — the run is deferred whole.
    expect(client.getPageCalls).toEqual([]);
    expect(counts.pagesDeleted).toBe(0);
    const remaining = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM pages WHERE space_key = $1 AND deleted_at IS NULL',
      ['DEV'],
    );
    expect(parseInt(remaining.rows[0]!.n, 10)).toBe(201);
  });

  it('reconciles normally at the cap boundary (exactly 200 candidates)', async () => {
    // 200 candidates is within the cap, so the run proceeds: each is confirmed gone
    // and soft-deleted. Guards against an off-by-one in the > vs >= comparison.
    const ids = Array.from({ length: 200 }, (_, i) => `edge-${i}`);
    for (const id of ids) await insertPage(id, 'DEV');

    const client = makeClient({ liveIds: [], goneForGetPage: ids });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(client.getPageCalls).toHaveLength(200);
    expect(counts.pagesDeleted).toBe(200);
  });

  // ── revival cross-check (#766 review) ────────────────────────────────────

  it('revives a soft-deleted page that is live in Confluence again (trash restore)', async () => {
    // A trash-restore creates no new version, so the incremental upsert never
    // re-upserts the page — the cross-check against the live listing is the only
    // path that converges it. The row was soft-deleted in an earlier cycle, so
    // `deleted_at` is comfortably older than the revival grace window.
    await insertPage('restored-1', 'DEV');
    await softDelete('restored-1', 60 * 60); // soft-deleted an hour ago

    const client = makeClient({ liveIds: ['restored-1'] });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(await getDeletedAt('restored-1')).toBeNull();
    // A revived page is in the live listing, so it is never a deletion candidate.
    expect(client.getPageCalls).toEqual([]);
    expect(counts.pagesDeleted).toBe(0);
  });

  it('does NOT revive a row soft-deleted within the grace window (in-flight delete intent)', async () => {
    // Interleaving guard: the delete routes record their delete INTENT as a
    // soft-delete BEFORE calling Confluence — until that upstream DELETE lands,
    // the page is still in the live listing. A reconciliation running in that
    // window must NOT resurrect the row mid-delete; the grace window (deleted_at
    // must be older than REVIVAL_GRACE_SECONDS) keeps the intent untouched.
    await insertPage('mid-delete', 'DEV');
    await softDelete('mid-delete', 0); // intent recorded "just now" by a delete route

    const client = makeClient({ liveIds: ['mid-delete'] }); // upstream delete not landed yet
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    // Still hidden: the in-flight delete proceeds undisturbed.
    expect(await getDeletedAt('mid-delete')).not.toBeNull();
    expect(client.getPageCalls).toEqual([]);
    expect(counts.pagesDeleted).toBe(0);
  });

  it('does not revive soft-deleted rows absent from the live listing (still deleted)', async () => {
    await insertPage('still-gone', 'DEV');
    await softDelete('still-gone', 60 * 60);

    const client = makeClient({ liveIds: [] });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(await getDeletedAt('still-gone')).not.toBeNull();
    expect(client.getPageCalls).toEqual([]);
  });

  it('revival is space-scoped: a live id in another space does not revive rows elsewhere', async () => {
    await insertPage('other-space', 'OTHER');
    await softDelete('other-space', 60 * 60);

    const client = makeClient({ liveIds: ['other-space'] });
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await detectDeletedPages(client as never, 'DEV', counts);

    expect(await getDeletedAt('other-space')).not.toBeNull();
  });
});

// ── purge upstream confirmation (#766 review) ───────────────────────────────

describe.skipIf(!dbAvailable)('purgeDeletedPages upstream gone-confirmation (#766 review)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60;

  it('purges a 30-day-old soft-deleted row once upstream confirms gone (404)', async () => {
    await insertPage('purge-404', 'DEV');
    await softDelete('purge-404', THIRTY_ONE_DAYS);

    const client = makeClient({ liveIds: [], goneForGetPage: ['purge-404'] });
    await purgeDeletedPages(client as never, 'DEV');

    expect(await rowExists('purge-404')).toBe(false);
    expect(client.getPageCalls).toEqual(['purge-404']);
  });

  it('purges when upstream still serves the page as trashed (200 trashed)', async () => {
    await insertPage('purge-trashed', 'DEV');
    await softDelete('purge-trashed', THIRTY_ONE_DAYS);

    const client = makeClient({ liveIds: [], trashedForGetPage: ['purge-trashed'] });
    await purgeDeletedPages(client as never, 'DEV');

    expect(await rowExists('purge-trashed')).toBe(false);
  });

  it('does NOT purge a row whose page is current upstream (diverged — left for reconciliation)', async () => {
    // E.g. restored from the trash but hidden from this principal's listing, so
    // the revival cross-check never saw it. Purge is irreversible, so a live
    // upstream answer must veto the local hard-delete.
    await insertPage('purge-current', 'DEV');
    await softDelete('purge-current', THIRTY_ONE_DAYS);

    const client = makeClient({ liveIds: [], presentForGetPage: ['purge-current'] });
    await purgeDeletedPages(client as never, 'DEV');

    expect(await rowExists('purge-current')).toBe(true);
    expect(await getDeletedAt('purge-current')).not.toBeNull(); // stays soft-deleted
  });

  it('does NOT purge on an inconclusive confirmation (403/5xx) — deferred to a later cycle', async () => {
    await insertPage('purge-403', 'DEV');
    await softDelete('purge-403', THIRTY_ONE_DAYS);

    const client = makeClient({
      liveIds: [],
      getPageError: () => new ConfluenceError('Insufficient permissions', 403),
    });
    await purgeDeletedPages(client as never, 'DEV');

    expect(await rowExists('purge-403')).toBe(true);
  });

  it('leaves rows younger than 30 days untouched (no confirmation fetch)', async () => {
    await insertPage('purge-young', 'DEV');
    await softDelete('purge-young', 24 * 60 * 60); // 1 day

    const client = makeClient({ liveIds: [], goneForGetPage: ['purge-young'] });
    await purgeDeletedPages(client as never, 'DEV');

    expect(await rowExists('purge-young')).toBe(true);
    expect(client.getPageCalls).toEqual([]);
  });

  it('purges only the confirmed-gone subset of a mixed candidate batch', async () => {
    await insertPage('mix-gone', 'DEV');
    await insertPage('mix-live', 'DEV');
    await softDelete('mix-gone', THIRTY_ONE_DAYS);
    await softDelete('mix-live', THIRTY_ONE_DAYS);

    const client = makeClient({
      liveIds: [],
      goneForGetPage: ['mix-gone'],
      presentForGetPage: ['mix-live'],
    });
    await purgeDeletedPages(client as never, 'DEV');

    expect(await rowExists('mix-gone')).toBe(false);
    expect(await rowExists('mix-live')).toBe(true);
  });
});
