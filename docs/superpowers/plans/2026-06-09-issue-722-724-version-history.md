# Unit D — #722 + #724: Real Confluence version history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a page's actual Confluence version history (incl. versions before first sync), with real edit timestamp + author + change message; lazily fetch historical bodies for preview/compare/restore; and stop presenting `syncedAt`/page-load time as the version date (#724).

**Architecture:** New read-only Confluence client methods list versions and fetch historical bodies. Migration 077 adds `edited_at`/`author`/`message` to `page_versions`. The version **list** is backfilled (idempotent) lazily when the History dialog opens; a historical **body** is fetched lazily only when a version is previewed/compared/restored, converted through `confluenceToHtml` (ADR-003), and persisted. The `/versions` response and the timeline UI surface real metadata; local/standalone pages keep snapshot behavior with an honestly-labeled "Synced …" fallback.

**Tech Stack:** Fastify 5, Postgres (real DB tests via `backend/src/test-db-helper.ts`), Confluence DC REST (`/rest/api/content/{id}/version`, `?status=historical&version={n}`), React 19 + TanStack Query, Zod contracts, Vitest.

**Branch:** `feature/issue-722-724-version-history` off `dev`. This is the **only** unit that adds a migration (077) and edits `@compendiq/contracts`; backend tests run `fileParallelism:false` against an isolated test Postgres; rebuild contracts (`npm run build -w @compendiq/contracts`) before running consumers.

**Confluence API (verified):** list = `GET /rest/api/content/{id}/version?expand=by,message&start=&limit=` (paginated, default 20/max ~200, current version included, `_links.next` for paging). Historical body = `GET /rest/api/content/{id}?status=historical&version={n}&expand=body.storage` → `body.storage.value` XHTML. Auth `Authorization: Bearer <PAT>` (already handled by the client). All read-only.

---

### Task 1: Migration 077 — Confluence version metadata columns

**Files:**
- Create: `backend/src/core/db/migrations/077_page_versions_confluence_metadata.sql`
- Test: `backend/src/core/db/migrations/__tests__/077_page_versions_confluence_metadata.test.ts`

- [ ] **Step 1: Write the failing migration test** (model on `__tests__/073_llm_audit_log.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

describe('migration 077 page_versions confluence metadata', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it('adds edited_at, author, message columns to page_versions', async () => {
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='page_versions'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(['edited_at', 'author', 'message']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/core/db/migrations/__tests__/077_page_versions_confluence_metadata.test.ts`
Expected: FAIL — columns absent.

- [ ] **Step 3: Write the migration**

```sql
-- Migration 077: real Confluence version metadata on page_versions (#722/#724)
-- edited_at = the version's actual Confluence edit time (version.when)
-- author    = version.by.displayName
-- message   = version.message (change comment)
-- All NULL for local/standalone snapshots, which keep using synced_at.
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ NULL;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS author TEXT NULL;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS message TEXT NULL;
```

(`body_html`/`body_text` are already nullable from migration 014, so metadata-only rows are allowed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/core/db/migrations/__tests__/077_page_versions_confluence_metadata.test.ts`
Also run the migrations integrity test: `npx vitest run src/core/db/migrations/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/db/migrations/077_page_versions_confluence_metadata.sql backend/src/core/db/migrations/__tests__/077_page_versions_confluence_metadata.test.ts
git commit -m "feat(db): migration 077 adds Confluence version metadata to page_versions (#722)"
```

---

### Task 2: Persistence helpers — `upsertVersionMetadata` + `fillVersionBody`

**Files:**
- Modify: `backend/src/core/services/version-snapshot.ts`
- Test: `backend/src/core/services/version-snapshot.test.ts` (extend or create)

- [ ] **Step 1: Write the failing test**

```ts
it('upsertVersionMetadata inserts then updates metadata idempotently', async () => {
  const id = await seedPage(); // returns pages.id
  await upsertVersionMetadata(id, 3, 'T', { editedAt: '2026-01-02T00:00:00Z', author: 'Ann', message: 'edit' });
  await upsertVersionMetadata(id, 3, 'T', { editedAt: '2026-01-02T00:00:00Z', author: 'Ann', message: 'edit' }); // no dup
  const r = await query(`SELECT author, message FROM page_versions WHERE page_id=$1 AND version_number=3`, [id]);
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({ author: 'Ann', message: 'edit' });
});

it('fillVersionBody fills a null body only', async () => {
  const id = await seedPage();
  await upsertVersionMetadata(id, 2, 'T', { editedAt: null, author: null, message: null });
  await fillVersionBody(id, 2, '<p>hi</p>', 'hi');
  const r = await query(`SELECT body_html FROM page_versions WHERE page_id=$1 AND version_number=2`, [id]);
  expect(r.rows[0]!.body_html).toBe('<p>hi</p>');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/core/services/version-snapshot.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers**

```ts
export async function upsertVersionMetadata(
  pageId: number,
  versionNumber: number,
  title: string,
  meta: { editedAt: string | Date | null; author: string | null; message: string | null },
): Promise<void> {
  await query(
    `INSERT INTO page_versions (page_id, version_number, title, edited_at, author, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (page_id, version_number) DO UPDATE SET
       edited_at = COALESCE(EXCLUDED.edited_at, page_versions.edited_at),
       author    = COALESCE(EXCLUDED.author, page_versions.author),
       message   = COALESCE(EXCLUDED.message, page_versions.message),
       title     = EXCLUDED.title`,
    [pageId, versionNumber, title, meta.editedAt, meta.author, meta.message],
  );
}

export async function fillVersionBody(
  pageId: number,
  versionNumber: number,
  bodyHtml: string,
  bodyText: string,
): Promise<void> {
  await query(
    `UPDATE page_versions SET body_html = $3, body_text = $4
       WHERE page_id = $1 AND version_number = $2 AND body_html IS NULL`,
    [pageId, versionNumber, bodyHtml, bodyText],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/core/services/version-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/services/version-snapshot.ts backend/src/core/services/version-snapshot.test.ts
git commit -m "feat(versions): upsertVersionMetadata + fillVersionBody helpers (#722)"
```

---

### Task 3: Confluence client — list versions + fetch historical body

**Files:**
- Modify: `backend/src/domains/confluence/services/confluence-client.ts` (add methods after `getPage` ~`:292`; add a `ConfluenceVersionMeta` interface near the `ConfluencePage` interface ~`:18`)
- Test: `backend/src/domains/confluence/services/confluence-client.versions.test.ts` (new; mock `fetch` at the HTTP boundary like the existing client tests)

- [ ] **Step 1: Write the failing test**

Mock global `fetch` (the client uses it under `fetchOnce`). Return a paginated version list then assert flattening, then a historical body:

```ts
it('getPageVersions flattens pagination and maps metadata', async () => {
  // page 1 (limit reached) then page 2 (final)
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ results: [{ number: 3, when: '2026-01-03T00:00:00Z', by: { displayName: 'A' }, message: 'm3' }], size: 1, _links: { next: '/next' } }))
    .mockResolvedValueOnce(jsonResponse({ results: [{ number: 2, when: '2026-01-02T00:00:00Z', by: { displayName: 'B' } }], size: 1, _links: {} }));
  const client = new ConfluenceClient('https://c.example.com', 'PAT');
  const versions = await client.getPageVersions('123');
  expect(versions.map((v) => v.number)).toEqual([3, 2]);
  expect(versions[0]).toMatchObject({ author: 'A', message: 'm3' });
});

it('getHistoricalPageBody returns the historical storage XHTML', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ body: { storage: { value: '<p>old</p>' } } }));
  const client = new ConfluenceClient('https://c.example.com', 'PAT');
  expect(await client.getHistoricalPageBody('123', 2)).toBe('<p>old</p>');
});
```

> Match the existing client tests' fetch-mock helpers (`backend/src/domains/confluence/services/confluence-client*.test.ts`) for `jsonResponse`/setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/domains/confluence/services/confluence-client.versions.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the methods**

Add the interface:

```ts
export interface ConfluenceVersionMeta {
  number: number;
  when: string;
  author: string | null;
  message: string | null;
  minorEdit: boolean;
}
```

Add methods (reuse the private `fetch<T>` helper at `:194`, which sets the Bearer header):

```ts
  /** #722: list a page's full version history (metadata only — cheap). */
  async getPageVersions(pageId: string): Promise<ConfluenceVersionMeta[]> {
    const out: ConfluenceVersionMeta[] = [];
    let start = 0;
    const limit = 100;
    for (;;) {
      const res = await this.fetch<{
        results: Array<{ number: number; when: string; by?: { displayName?: string }; message?: string; minorEdit?: boolean }>;
        size: number;
        _links?: { next?: string };
      }>(`/rest/api/content/${encodeURIComponent(pageId)}/version?expand=by,message&start=${start}&limit=${limit}`, { method: 'GET' });
      for (const v of res.results) {
        out.push({ number: v.number, when: v.when, author: v.by?.displayName ?? null, message: v.message ?? null, minorEdit: v.minorEdit ?? false });
      }
      if (!res._links?.next || res.results.length < limit) break;
      start += limit;
    }
    return out;
  }

  /** #722: fetch a historical version's storage-format body (read-only). */
  async getHistoricalPageBody(pageId: string, version: number): Promise<string> {
    const res = await this.fetch<{ body?: { storage?: { value?: string } } }>(
      `/rest/api/content/${encodeURIComponent(pageId)}?status=historical&version=${version}&expand=body.storage`,
      { method: 'GET' },
    );
    return res.body?.storage?.value ?? '';
  }
```

> Confirm the `this.fetch` options shape (the file shows `private async fetch<T>(path, options: {...})` at `:194`); pass whatever the existing GET callers pass (e.g. `getSpaces`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/domains/confluence/services/confluence-client.versions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/confluence/services/confluence-client.ts backend/src/domains/confluence/services/confluence-client.versions.test.ts
git commit -m "feat(confluence): client methods to list versions + fetch historical body (#722)"
```

---

### Task 4: Backfill service — list import + lazy body import

**Files:**
- Create: `backend/src/domains/confluence/services/version-backfill.ts`
- Test: `backend/src/domains/confluence/services/version-backfill.test.ts` (new; real DB + mocked client)

The service needs the per-user Confluence client. Reuse the existing client factory used by sync (grep `new ConfluenceClient(` in `sync-service.ts` / a `getConfluenceClient` helper) so PAT decryption/base-url resolution is identical.

- [ ] **Step 1: Write the failing test**

```ts
it('backfillVersionHistory upserts one metadata row per Confluence version (idempotent)', async () => {
  const pageId = await seedConfluencePage('c-1');           // pages row, confluence_id='c-1'
  const client = { getPageVersions: vi.fn().mockResolvedValue([
    { number: 2, when: '2026-01-02T00:00:00Z', author: 'A', message: 'm', minorEdit: false },
    { number: 1, when: '2026-01-01T00:00:00Z', author: 'A', message: null, minorEdit: false },
  ]) };
  await backfillVersionHistory(pageId, 'c-1', client as never);
  await backfillVersionHistory(pageId, 'c-1', client as never); // idempotent
  const r = await query(`SELECT version_number, author, edited_at FROM page_versions WHERE page_id=$1 ORDER BY version_number`, [pageId]);
  expect(r.rows.map((x) => x.version_number)).toEqual([1, 2]);
});

it('getHistoricalBody fetches, converts via confluenceToHtml, and fills the body', async () => {
  const pageId = await seedConfluencePage('c-2');
  await upsertVersionMetadata(pageId, 1, 'T', { editedAt: null, author: null, message: null });
  const client = { getHistoricalPageBody: vi.fn().mockResolvedValue('<p>old</p>') };
  const body = await getHistoricalBody(pageId, 'c-2', 1, client as never);
  expect(body.bodyHtml).toContain('old');
  const r = await query(`SELECT body_html FROM page_versions WHERE page_id=$1 AND version_number=1`, [pageId]);
  expect(r.rows[0]!.body_html).toContain('old');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/domains/confluence/services/version-backfill.test.ts`
Expected: FAIL — module/functions don't exist.

- [ ] **Step 3: Implement the backfill service**

```ts
import type { ConfluenceClient } from './confluence-client.js';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { upsertVersionMetadata, fillVersionBody } from '../../../core/services/version-snapshot.js';
import { logger } from '../../../core/utils/logger.js';

/** #722: import the version LIST (metadata only) for a Confluence-synced page. Idempotent. */
export async function backfillVersionHistory(
  pageId: number,
  confluenceId: string,
  client: ConfluenceClient,
): Promise<{ imported: number }> {
  const versions = await client.getPageVersions(confluenceId);
  for (const v of versions) {
    await upsertVersionMetadata(pageId, v.number, `v${v.number}`, {
      editedAt: v.when ?? null,
      author: v.author,
      message: v.message,
    });
  }
  logger.info({ pageId, confluenceId, imported: versions.length }, '#722: backfilled version metadata');
  return { imported: versions.length };
}

/** #722: lazily fetch + persist a historical body, converting storage XHTML via ADR-003. */
export async function getHistoricalBody(
  pageId: number,
  confluenceId: string,
  versionNumber: number,
  client: ConfluenceClient,
): Promise<{ bodyHtml: string; bodyText: string }> {
  const storage = await client.getHistoricalPageBody(confluenceId, versionNumber);
  const bodyHtml = confluenceToHtml(storage, confluenceId);
  const bodyText = htmlToText(bodyHtml);
  await fillVersionBody(pageId, versionNumber, bodyHtml, bodyText);
  return { bodyHtml, bodyText };
}
```

> Use the real title for the metadata row if cheaply available; `v{n}` is an acceptable placeholder title since the UI shows the page title for the current row and the version number for historical rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/domains/confluence/services/version-backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/confluence/services/version-backfill.ts backend/src/domains/confluence/services/version-backfill.test.ts
git commit -m "feat(versions): backfill version list + lazy historical body import (#722)"
```

---

### Task 5: Contracts — `PageVersionSummary` schema

**Files:**
- Create/modify: `packages/contracts/src/schemas/page-versions.ts` (new) + re-export from `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/schemas/page-versions.test.ts` (if the package tests schemas) — otherwise rely on type usage

- [ ] **Step 1: Add the schema**

```ts
import { z } from 'zod';

export const PageVersionSummarySchema = z.object({
  versionNumber: z.number(),
  title: z.string(),
  editedAt: z.string().nullable(),
  syncedAt: z.string().nullable(),
  author: z.string().nullable(),
  message: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type PageVersionSummary = z.infer<typeof PageVersionSummarySchema>;

export const PageVersionsResponseSchema = z.object({
  versions: z.array(PageVersionSummarySchema),
  pageId: z.string(),
});
export type PageVersionsResponse = z.infer<typeof PageVersionsResponseSchema>;
```

Re-export both from `packages/contracts/src/index.ts` following the existing export style.

- [ ] **Step 2: Build the package**

Run: `npm run build -w @compendiq/contracts`
Expected: builds; new exports present in `dist`.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/schemas/page-versions.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): PageVersionSummary schema for version history (#722)"
```

---

### Task 6: Read path — backfill-on-open, real metadata, lazy body, fix current row (#724)

**Files:**
- Modify: `backend/src/domains/knowledge/services/version-tracker.ts:29-57` (`getVersionHistory` SELECT + mapping)
- Modify: `backend/src/routes/knowledge/pages-versions.ts:92-134` (backfill on open + current-row fix) and `:137+` (lazy body on single-version GET)
- Test: `backend/src/routes/knowledge/pages-versions.test.ts` (extend; real DB + mocked confluence client)

- [ ] **Step 1: Write the failing tests**

```ts
it('GET /versions returns real edited_at/author/message for historical rows (#722)', async () => {
  // seed a confluence page + a page_versions row with edited_at/author/message
  const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/versions` });
  const v = res.json().versions.find((x) => !x.isCurrent);
  expect(v).toMatchObject({ author: 'Ann', message: 'typo fix' });
  expect(v.editedAt).toBe('2026-01-02T00:00:00.000Z');
});

it('current row has editedAt:null when last_modified_at is null — no page-load time (#724)', async () => {
  // seed page with last_modified_at = NULL
  const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/versions` });
  const cur = res.json().versions.find((x) => x.isCurrent);
  expect(cur.editedAt).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/knowledge/pages-versions.test.ts`
Expected: FAIL — response lacks `editedAt`/`author`/`message`; current row uses `new Date()`.

- [ ] **Step 3: Extend `getVersionHistory`**

Add the new columns to the SELECT and mapping in `version-tracker.ts:29-57`:

```ts
  const result = await query<{
    version_number: number; title: string; synced_at: Date;
    edited_at: Date | null; author: string | null; message: string | null;
  }>(
    `SELECT version_number, title, synced_at, edited_at, author, message
       FROM page_versions WHERE page_id = $1 ORDER BY version_number DESC`,
    [pageId],
  );
  return result.rows.map((r) => ({
    versionNumber: r.version_number,
    title: r.title,
    syncedAt: r.synced_at?.toISOString() ?? null,
    editedAt: r.edited_at?.toISOString() ?? null,
    author: r.author,
    message: r.message,
  }));
```

- [ ] **Step 4: Backfill-on-open + current-row fix in the route**

In `pages-versions.ts` GET `/pages/:id/versions`, before `getVersionHistory`, backfill from Confluence when the page is synced (best-effort — never fail the dialog):

```ts
    if (ctx.confluenceId) {
      try {
        const client = await getConfluenceClientForUser(userId); // reuse sync's factory
        if (client) await backfillVersionHistory(ctx.id, ctx.confluenceId, client);
      } catch (err) {
        request.log.warn({ err, pageId: id }, '#722: version backfill skipped (Confluence unavailable)');
      }
    }
    const versions = await getVersionHistory(ctx.id);
```

Fix the synthetic current row (`:112-118`) so it never emits page-load time, and carries the new fields:

```ts
    const currentVersion = currentResult.rows[0]
      ? {
          versionNumber: currentResult.rows[0].version,
          title: currentResult.rows[0].title,
          editedAt: currentResult.rows[0].last_modified_at?.toISOString() ?? null,
          syncedAt: currentResult.rows[0].last_modified_at?.toISOString() ?? null,
          author: null,
          message: null,
          isCurrent: true,
        }
      : null;
```

Update the historical `.map((v) => ({ ...v, isCurrent: false }))` — it already spreads the new fields from `getVersionHistory`.

> `ctx.confluenceId`: confirm `resolveAndAuthorize` exposes the page's `confluence_id`; if not, add it to that resolver's SELECT/return. Standalone pages (`confluenceId` null) skip backfill and keep local snapshots.

- [ ] **Step 5: Lazy body on single-version GET**

In `pages-versions.ts` GET `/pages/:id/versions/:version` (`:137+`): after loading the version, if `body_html` is null and `ctx.confluenceId` is set, call `getHistoricalBody(ctx.id, ctx.confluenceId, versionNum, client)` and return its body. Add a test asserting a metadata-only version's body is fetched and persisted on first request.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/knowledge/pages-versions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/domains/knowledge/services/version-tracker.ts backend/src/routes/knowledge/pages-versions.ts backend/src/routes/knowledge/pages-versions.test.ts
git commit -m "feat(versions): backfill-on-open, real metadata, lazy body, fix current-row date (#722/#724)"
```

---

### Task 7: Frontend — show real edit time + author + message; honest fallback (#724)

**Files:**
- Modify: `frontend/src/features/pages/VersionHistory.tsx:12-17` (type) and `:247-249` (render)
- Test: `frontend/src/features/pages/VersionHistory.test.tsx` (extend or create)

- [ ] **Step 1: Write the failing test**

```tsx
it('renders the real Confluence edit time + author + message when present (#722)', async () => {
  mockVersions([{ versionNumber: 3, title: 'Guide', editedAt: '2026-01-02T15:00:00Z', syncedAt: '2026-06-09T00:00:00Z', author: 'Ann', message: 'typo fix', isCurrent: false }]);
  // open dialog
  expect(await screen.findByText(/Ann/)).toBeInTheDocument();
  expect(screen.getByText(/typo fix/)).toBeInTheDocument();
  expect(screen.queryByText(/Synced/)).not.toBeInTheDocument(); // editedAt present → no "Synced" label
});

it('falls back to a labeled "Synced …" when editedAt is null, never page-load time (#724)', async () => {
  mockVersions([{ versionNumber: 1, title: 'Local', editedAt: null, syncedAt: '2026-06-09T00:00:00Z', author: null, message: null, isCurrent: false }]);
  expect(await screen.findByText(/Synced/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/pages/VersionHistory.test.tsx`
Expected: FAIL — type lacks the fields; render shows `syncedAt` unlabeled.

- [ ] **Step 3: Update the type + render**

Type (`:12-17`) — mirror the contract:

```tsx
interface PageVersionSummary {
  versionNumber: number;
  title: string;
  editedAt: string | null;
  syncedAt: string | null;
  author: string | null;
  message: string | null;
  isCurrent: boolean;
}
```

Render (`:247-249`) — prefer real edit time + author + message; honest fallback:

```tsx
                      <p className="truncate text-xs text-muted-foreground">
                        {version.title}
                        {version.editedAt
                          ? <> · {new Date(version.editedAt).toLocaleString()}{version.author ? ` · ${version.author}` : ''}</>
                          : version.syncedAt
                            ? <> · Synced {new Date(version.syncedAt).toLocaleString()}</>
                            : <> · —</>}
                      </p>
                      {version.message && (
                        <p className="truncate text-xs text-muted-foreground/80 italic">{version.message}</p>
                      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/pages/VersionHistory.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd frontend && npx eslint src/features/pages/VersionHistory.tsx
git add frontend/src/features/pages/VersionHistory.tsx frontend/src/features/pages/VersionHistory.test.tsx
git commit -m "feat(versions): show real Confluence edit time/author/message; honest Synced fallback (#722/#724)"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `docs/architecture/06-data-model.md` (page_versions new columns), `docs/architecture/08-flow-sync.md` (version backfill-on-open + lazy body), `docs/architecture/11-content-pipeline.md` (historical-body conversion via confluenceToHtml)

- [ ] **Step 1:** Update the three docs above.
- [ ] **Step 2:** `npm run build -w @compendiq/contracts` then `cd backend && npx vitest run src/core/db/migrations/__tests__/077_page_versions_confluence_metadata.test.ts src/core/services/version-snapshot.test.ts src/domains/confluence/services/confluence-client.versions.test.ts src/domains/confluence/services/version-backfill.test.ts src/routes/knowledge/pages-versions.test.ts` — green.
- [ ] **Step 3:** `cd backend && npm run lint && npm run typecheck` — clean.
- [ ] **Step 4:** `cd frontend && npx vitest run src/features/pages/VersionHistory.test.tsx && npx tsc --noEmit` — clean.
- [ ] **Step 5:** Open PR `feat(versions): import real Confluence version history (#722, #724)` targeting `dev`; flag the docs/diagram updates per CLAUDE.md rule 6.

## Acceptance mapping
- Real Confluence history incl. pre-first-sync versions → Tasks 3+4+6 (list backfill on open).
- Synced-once page shows >1 version → list import (Task 4) not local snapshots.
- Each entry shows real edit time + author + message → Tasks 6+7.
- Preview/compare/AI-diff/restore work on backfilled versions → Task 6 lazy body (existing restore path reads `page_versions`).
- Backfill idempotent, respects rate limits, logs → Tasks 2 (`ON CONFLICT`) + 4 (`log()`), client paging.
- Standalone pages keep working; viewing pushes nothing to Confluence → `confluenceId` guard; all calls read-only.
- #724: current row stable across reloads; `syncedAt` never shown as edit time → Tasks 6+7.
