# Design: Implement open issues #718, #721, #722, #723, #724

- **Date:** 2026-06-09
- **Branch model:** feature branches off `dev`, PRs target `dev`
- **Status:** Approved — ready for per-unit implementation plans

## Summary

Five filed issues are implemented in this batch. They collapse into **four
independent work units** because #722 and #724 share the same files
(`pages-versions.ts`, `VersionHistory.tsx`) and must be owned together. Each
unit is implemented in its own git worktree by one member of an experimental
agent team (TeamCreate), follows TDD, and produces a branch + PR targeting `dev`.

| Unit | Issues | Touches | DB? | Contracts? | Migration? |
|---|---|---|---|---|---|
| **A** | #718 | frontend only | no | no | no |
| **B** | #721 | backend + frontend | yes (purge) | maybe | no |
| **C** | #723 | backend (converter + llm route) | apply-path test | no | no |
| **D** | #722 + #724 | backend + frontend | yes | **yes** | **077** |

Only **D** changes the migration sequence (077) and the `@compendiq/contracts`
package, so there are no migration-number or contracts-dist collisions between
parallel agents.

## Decisions (locked)

- Implement **all five** issues this round.
- #722 depth: **metadata-list backfilled lazily on History-dialog open + lazy
  historical bodies** (bounded; pagination inherits the client's rate limiter /
  `CONFLUENCE_RATE_LIMIT_RPM` token acquisition, plus a defensive max-iteration
  cap in `getPageVersions`).
- #723 fix: **both** placeholder-protection (round-trip safety) **and** converter
  rules (general fidelity).
- Unit A gates the Auto-tag button on an `aiConfigured` flag derived from the
  **new** providers/usecase source, not the removed legacy settings fields.
- Execution: experimental agent team, one member per unit, isolated worktrees;
  backend units get isolated test Postgres + `fileParallelism:false`.

---

## Unit A — #718: restore the AI Auto-tag button (frontend only)

**Root cause:** `ArticleRightPane` renders `AutoTagger` only when a derived
`activeModel` is truthy, computed from **legacy** settings fields
(`llmProvider`/`ollamaModel`/`openaiModel`) that ADR-021 / migration 054 emptied.
So the button silently disappears.

**Approach:**
1. Delete the legacy `activeModel` derivation (`ArticleRightPane.tsx:207-210`).
2. Remove `&& activeModel` from the three render gates — collapsed rail (`:511`),
   edit mode (`:655`), read mode (`:678`).
3. Make `AutoTagger`'s `model` prop **optional** (`AutoTagger.tsx:14-19`) and stop
   sending `{ model }` when absent (`:29-31`) — the route resolves `auto_tag`
   server-side (`pages-tags.ts`, `auto-tagger.ts` via `resolveUsecase('auto_tag')`).
4. To avoid a dead button when **no** LLM is configured at all, gate on an
   `aiConfigured` flag derived from the **new** provider/usecase source, mirroring
   `AiContext.tsx:264-272` (`/llm/usecase-default?usecase=...` query) — not the
   removed legacy fields.

**Tests:** Rewrite `ArticleRightPane.test.tsx` to drop legacy
`ollamaModel`/`llmProvider`; add a regression test asserting the button renders
with the new provider model and **without** any legacy field, in read mode, edit
mode, and the collapsed rail.

**Acceptance:** button reappears below AI Improve in all three modes; clicking it
calls `POST /pages/:id/auto-tag` with no legacy model; no dependence on removed
`settings.llmProvider`/`openaiModel`/`ollamaModel`.

---

## Unit B — #721: unsync / remove a synced space (backend + frontend)

**Root cause:** (1) For admins, `getUserAccessibleSpaces` returns **all** spaces,
so the Spaces-tab "selected" set always re-includes a deselected space → deselect
is a no-op. (2) Save/Sync are `disabled={selected.size === 0}`, so the last space
can't be removed. (3) No endpoint deletes a synced `spaces` row + its pages.

**Backend:**
- New endpoint `DELETE /api/spaces/:key` (modeled on existing
  `DELETE /api/spaces/local/:key`) backed by an exported `unsyncSpace(spaceKey)`
  purge in the confluence domain that, for the target space:
  - deletes its `pages` with a raw `DELETE FROM pages WHERE space_key = $1`; the
    `page_id` FK (migration 030) cascades the delete to `page_embeddings` and
    `page_versions`. (As-built it does **not** call `purgeDeletedPages`, which is
    the soft-delete-reconciliation path; the unsync path is a hard purge relying on
    the FK cascade.)
  - deletes the `spaces` row;
  - reconciles **orphaned `space_key` rows** that carry no FK to `spaces` (see the
    orphan-reconciliation note below);
  - is **read-only against Confluence** (no upstream writes);
  - requires admin authorization.
- **Transactionality (as-built):** all row deletes/updates run inside a single
  `BEGIN`/`COMMIT` transaction on one pooled client (`getPool().connect()`), with
  `ROLLBACK` + re-throw on any error. Filesystem attachment cleanup
  (`cleanPageAttachments` per page) is **best-effort and runs OUTSIDE the
  transaction, before it opens** — a file-cleanup failure is logged and never
  aborts the DB work. Worst case is a few orphaned files if the transaction later
  rolls back; a re-run of unsync sweeps them again.
- **Orphan reconciliation (all inside the transaction):**
  - `DELETE` all `space_role_assignments` for the space — this table holds RBAC
    **and** encodes the sync selection (the old `user_space_selections` table was
    migrated into it and **DROPPED in migration 040**; it no longer exists).
  - `DELETE` `oidc_group_role_mappings` rows whose `space_key` matches the space
    (a non-null `space_key` row maps a group into *this* space and is meaningless
    once the space is gone; global `space_key IS NULL` rows are untouched).
  - `UPDATE … SET space_key = NULL` on `templates` and `knowledge_requests` — these
    may hold user-authored content, so we **detach** (retain the row, NULL the
    nullable `space_key`) rather than destroy work.
- Decouple the Spaces-tab "selected" set from `getUserAccessibleSpaces`. The tab's
  selection should reflect **actually-synced spaces** (rows in `spaces`), so a
  removal is visible to admins after refresh.

**Frontend (`SpacesTab.tsx`):**
- Add a per-space **Remove / stop syncing** action calling the new endpoint, with
  a confirm dialog warning: *"This deletes synced pages locally — it does not
  touch anything in Confluence."*
- Relax `disabled={selected.size === 0}` on **Save** so an empty selection
  persists (keep **Sync** disabled at 0).
- After removal, refetch so the space disappears and stays gone.

**Docs:** update `docs/architecture/08-flow-sync.md` (sync selection + purge path).

**Acceptance:** an admin can remove a space; it stops syncing, its pages disappear
locally, and it stays removed after refresh; removal works down to zero selected;
cleans up pages/embeddings/attachments + all `space_role_assignments` +
space-scoped `oidc_group_role_mappings`, and detaches `templates` /
`knowledge_requests` (NULL `space_key`); the DB work is atomic (single
transaction, rollback on error); nothing deleted in Confluence; non-admin deselect
still loses access without orphaned data.

---

## Unit C — #723: AI Improve must not destroy images / draw.io (backend)

**Root cause:** AI Improve round-trips `bodyHtml` through Markdown
(`htmlToMarkdown` → LLM → `markdownToHtml`). Markdown can't represent
`.confluence-drawio` wrappers or `data-confluence-*` image metadata; turndown has
no rule for them, so they're flattened/stripped and the lossy result overwrites
the page on Accept.

**Approach — both layers:**

1. **Placeholder protection (primary, in the Improve round-trip):**
   - Before `htmlToMarkdown` in `routes/llm/_helpers.ts:63`, replace `<img>`,
     `.confluence-drawio`, mermaid, and layout/column nodes with opaque stable
     tokens (e.g. `⟦MEDIA:0⟧`) and keep a token → original-HTML map.
   - After `markdownToHtml` on Accept (`llm-conversations.ts:133-134`), re-inject
     the originals verbatim by token. The LLM only ever sees/edits prose; media is
     byte-identical.
   - **Accept guard:** before save, diff drawio/attachment references in the
     improved HTML vs the original; if any are missing, merge them back (defense in
     depth) so Accept can never silently delete media.

2. **Converter coverage (general fidelity, acknowledged-lossy):**
   - Add a turndown rule for `confluence-drawio` with matching `markdownToHtml`
     reconstruction. **As-built this rule is name-only**: it emits a ```drawio fence
     carrying just `data-diagram-name`, and `markdownToHtml` rebuilds a bare
     `<div class="confluence-drawio" data-diagram-name="…">` — it does **not**
     preserve the inner `<img>` attachment ref or the inline edit link. So on the
     pure-converter path (any non-improve `htmlToMarkdown` caller) the diagram is
     **lossy** (degrades to name-only), not lossless. Losslessness for AI Improve is
     guaranteed by the placeholder-protection layer above (which protects the whole
     `div.confluence-drawio` wrapper byte-for-byte), **not** by this converter rule.

**Tests:** a page containing an image + a draw.io diagram survives improve→apply
with `data-confluence-*` and `.confluence-drawio` / `data-diagram-name` intact —
including the "LLM drops the line" case (placeholders preserve it). Ideally cover
mermaid/layout too.

**Acceptance:** improve→Accept keeps images and diagrams rendering exactly as
before; the Confluence write-back path (`htmlToConfluence` using
`data-confluence-filename`) and the inline draw.io edit button keep working; the
LLM cannot drop media.

---

## Unit D — #722 + #724: real Confluence version history (backend + frontend)

**Root cause (#722):** Compendiq builds history forward from the first sync and
never pulls existing Confluence history. The client has no version-history method;
`page_versions` is filled only by local sync-time snapshots; the read path returns
the synthetic current row + local snapshots. **(#724):** the timeline prints
`syncedAt` (sync/snapshot time) as if it were the version's edit time, and the
current row falls back to `new Date()` (page-load time) when `last_modified_at` is
null.

**Confluence client (`confluence-client.ts`):**
- `getPageVersions(id)` → paginated list via
  `GET /rest/api/content/{id}/version?expand=by,message&start=&limit=100`; each
  item yields `number`, `when`, `by.displayName`, `message`, `minorEdit`. Pages
  through `_links.next` (limit 100). Cheap (metadata only). **Throttle/cap live
  here:** every request goes through the client's private `fetchOnce`, which calls
  `acquireToken()` (the per-instance rate limiter / `CONFLUENCE_RATE_LIMIT_RPM`), so
  pagination is automatically throttled; a defensive `maxIterations = 1000` guard
  plus an empty-results break guarantee termination even on a misbehaving
  self-referential `_links.next`.
- `getHistoricalPageBody(id, n)` →
  `GET /rest/api/content/{id}?status=historical&version={n}&expand=body.storage,version`
  → XHTML storage; run through `confluenceToHtml` (ADR-003) before persisting
  `body_html`/`body_text`, exactly like live pages.
- Bearer-PAT auth; **read-only** (fetching historical content never mutates the
  server). Mind documented DC stale-`version`/`modificationDate` → HTTP 500 quirks.

**Schema (migration 077):**
- Add `edited_at TIMESTAMPTZ`, `author TEXT`, `message TEXT` to `page_versions`.
- Allow `body_html` / `body_text` to be **null** for metadata-only rows (lazy
  bodies). Keep the `(page_id, version_number)` unique index.
- Migration test under `migrations/__tests__/077_*.test.ts`.

**Flow:**
- **Lazily** upsert the **version-list metadata** when the History dialog opens
  (`GET /pages/:id/versions`), not eagerly during sync — best-effort, never fails
  the dialog. Idempotent `ON CONFLICT (page_id, version_number)`; metadata is
  updated when it becomes available. Cheap; throttled by the client rate limiter
  (see above).
- Fetch a historical **body only when** a version is previewed/compared/restored
  and its body is null; then persist (converted) + serve. Lazy = bounded cost.
- The list-pagination cap/break and the rate-limit throttle both live in
  `getPageVersions`/`fetchOnce` (no silent truncation in normal operation).
- **Standalone / local pages** (no `confluence_id` / non-Confluence space) keep the
  local-snapshot behavior — no Confluence calls.

**Read path + #724 fix:**
- `GET /pages/:id/versions` returns real `editedAt` / `author` / `message`.
- The timeline shows the real Confluence edit time + author + change message when
  present; for local pages it falls back to a clearly **labeled** `Synced …`.
- The synthetic current row returns `editedAt: null` (rendered "—"/"Unknown")
  instead of `new Date()`, so the value is stable across reloads.

**Contracts:** new `PageVersionSummary` schema in `packages/contracts/src/schemas`
(`versionNumber`, `title`, `editedAt: string | null`, `syncedAt: string | null`,
`author: string | null`, `message: string | null`, `isCurrent`), re-exported via
the package index; frontend `PageVersionSummary` type mirrors it. As-built the
package also adds `PageVersionsResponseSchema` (`{ versions, pageId }`) and a new
`PageVersionDetailSchema` for the single-version response (nullable `bodyHtml` /
`bodyText`, optional metadata). The route **validates** its responses with
`PageVersionsResponseSchema.parse(...)` / `PageVersionDetailSchema.parse(...)`.

**Restore / compare (data-loss fix):** backfilled rows are metadata-only
(`body_html IS NULL`) until previewed.
- **Restore** first lazy-fetches a NULL (never-previewed) historical body via
  `getHistoricalBody` *before* restoring; `restoreVersion` additionally guards
  (ROLLBACK + throw) if the resolved body is still empty, rather than blanking the
  live page or pushing an empty body upstream to Confluence.
- **Semantic-diff (AI-diff)** lazy-fetches **both** versions' bodies before diffing
  (so metadata-only rows don't diff as "all content removed"), and resolves its
  model from the `chat` use-case server-side (`resolveUsecase('chat')`,
  `model || resolvedModel`) — no hardcoded model is required from the client.
- Preview/text-compare operate on the (lazily-filled) historical body.

**Docs:** update `docs/architecture/06-data-model.md` (page_versions columns) and
`08-flow-sync.md` (version backfill); note the historical-body conversion in
`11-content-pipeline.md` if non-trivial.

**Acceptance:** opening Version History on a Confluence-synced page lazily backfills
and shows the page's **actual** Confluence history (incl. versions before first
sync and on a synced-once page); each entry shows the real edit timestamp, author,
and change message; preview/compare/AI-diff/restore work against backfilled
versions (lazy-fetching NULL bodies first, with the restore data-loss guard);
backfill is idempotent and throttled by the client rate limiter (pagination cap in
`getPageVersions`); standalone pages keep working; viewing history pushes nothing to
Confluence; the current row's `editedAt` is `null` (rendered "—"/"Unknown") and
stable across reloads.

---

## Execution: experimental agent team (TeamCreate)

- One team member per unit, each in its own git worktree off `dev`:
  `feature/issue-718-autotag-button`, `feature/issue-721-space-unsync`,
  `feature/issue-723-improve-media`, `feature/issue-722-724-version-history`.
- **Parallel-infra safeguards** (known gotchas in this repo):
  - Each **backend** unit (B, C, D) uses its **own isolated test Postgres
    database** and runs vitest with `fileParallelism:false`; DB tests hit real
    Postgres (never mocked).
  - **D** owns the version-history contract (`PageVersionSummary`). **B** may add a
    small space-unsync contract in a **different** schema file, so the two never
    edit the same source. Because worktrees are isolated, each unit that changes
    contracts rebuilds its **own** worktree's `@compendiq/contracts` dist (A/C, which
    don't touch contracts, resolve to the main checkout's dist) — no cross-unit
    collision either way.
  - Only **D** adds a migration (077) — no number collisions.
- Each unit: write spec → TDD implementation → `lint` + `typecheck` + `test` green
  → branch + PR targeting `dev`. Each PR updates the relevant `docs/`,
  `.env.example` (if applicable), and `CLAUDE.md` per the repo's documentation rule.

## Out of scope / non-goals

- No full eager backfill of every historical body (lazy bodies only).
- No new Confluence **write** paths; all new Confluence calls are read-only.
- No unrelated refactors beyond what each unit needs to land cleanly.
- OIDC/SSO and other EE-only surfaces are untouched.
