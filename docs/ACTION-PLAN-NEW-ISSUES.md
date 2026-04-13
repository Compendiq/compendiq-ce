# Action Plan: Issues #33, #34, #35, #10, #13, #17, #24, #25

Created: 2026-04-01. **Audited: 2026-04-01** — corrections applied after critical codebase verification.

Excludes issue #30 (UI: Design premium light and dark color themes).

---

## Audit Corrections (2026-04-01)

Critical errors found and corrected in the original plan:

| # | Original Assumption | Audit Finding | Impact |
|---|---------------------|---------------|--------|
| 1 | **#35**: Converter and TipTap node may be misaligned | **Already fully aligned** — round-trip works, 6 tests pass | Scope reduced: core conversion done, expanded to UX polish |
| 2 | **#33**: `deleted_at` column needs to be created | **Already exists** — migration 029 added it + partial index | No migration needed for soft-delete infra |
| 3 | **#33**: Need to add `deleted_at IS NULL` to all queries | **Already present in 89 places** across 45 files | No query changes needed |
| 4 | **#33**: `parent_id` never updated after initial sync | **Already updated** — `syncPage()` sets `parent_id` from ancestors on every sync | Move detection backend already works; investigate frontend |
| 5 | **#24**: Attachments macro "already handled" by converter | **Falls through to UnknownMacro** — no specific handler exists | Must add converter handler (more work than estimated) |
| 6 | **#33**: Estimated 3-4h | Real scope is ~1-2h (soft-delete fix + investigation) | Reduced |
| 7 | **#35**: Estimated 2-3h for verification only | Expanded scope: UX polish, styling, editing improvements | Adjusted |

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| #33 deletion mode | **Soft-delete** (use existing `deleted_at` column) | Already exists in schema; 89 queries already filter on it |
| #33 move scope | **Same-space only** + investigate first | parent_id already updated; real bug may be frontend cache |
| #34 linting scope | **Deferred** (language selector + auto-detection only) | Linting requires CodeMirror — separate issue |
| #35 scope | **Expanded** — core conversion done, focus on UX polish | Round-trip works; value is in better editing/rendering UX |
| Sprint order | Sync → Editor standalone → Code blocks → Macros → Captions | Data integrity first, then self-contained, then complex |

---

## Sprint 1: Sync Fixes + Status Polish (#33, #35) — ~1 day

### Issue #33 — Detect and apply page deletions and moves from Confluence

**Audit-corrected baseline:**
- `deleted_at` column + index **already exist** (migration 029)
- `deleted_at IS NULL` **already used** in 89 queries across 45 files
- `parent_id` **already updated** in `syncPage()` from `page.ancestors`
- `detectDeletedPages()` at `sync-service.ts:458` uses hard `DELETE` — **the only real backend bug**
- `ancestors` are **already fetched** in both `getPages()` and `getModifiedPages()` API calls

**Real work required:**

#### Part A: Fix soft-delete (the actual bug)

1. **`backend/src/domains/confluence/services/sync-service.ts`** — Change `detectDeletedPages()`
   - Replace `DELETE FROM pages WHERE confluence_id = $1` (line 488) with:
     ```sql
     UPDATE pages SET deleted_at = NOW() WHERE confluence_id = $1 AND deleted_at IS NULL
     ```
   - Ensure only Confluence-sourced pages are affected (not standalone articles)
   - Clean up associated resources: still call `cleanPageAttachments()` and `clearPageFailures()`

2. **`backend/src/domains/confluence/services/sync-service.ts`** — Add purge function
   - New function `purgeDeletedPages()`:
     ```sql
     DELETE FROM pages WHERE deleted_at < NOW() - INTERVAL '30 days'
     ```
   - Call at end of full sync (after `detectDeletedPages`)

3. **`backend/src/domains/confluence/services/sync-service.ts`** — Restore un-deleted pages
   - If a previously soft-deleted page reappears in Confluence (was restored from trash):
     ```sql
     UPDATE pages SET deleted_at = NULL WHERE confluence_id = $1 AND deleted_at IS NOT NULL
     ```
   - Add this to `syncPage()` before the main update

#### Part B: Investigate move detection bug

4. **Investigation required** — Two possible root causes:
   - **Frontend cache**: TanStack Query may cache the page tree and not invalidate after sync. Check if `queryClient.invalidateQueries()` is called when sync completes.
   - **Incremental sync gap**: If a page is moved in Confluence but its content doesn't change, does Confluence update `lastmodified`? If not, `getModifiedPages()` won't pick it up. Test this with a real Confluence instance.
   - **Action**: Reproduce the bug first, then fix the identified root cause.

#### Part C: Incremental deletion detection (stretch goal)

5. During incremental sync, track `Set<string>` of seen confluence_ids. After sync, compare against stored pages for the space. Pages not seen for 2 consecutive incremental cycles → soft-delete. This prevents the 24h delay for deletion detection.

**Tests:**
- `sync-service.test.ts` — `detectDeletedPages` now sets `deleted_at` instead of deleting
- `sync-service.test.ts` — `purgeDeletedPages` removes pages older than 30 days
- `sync-service.test.ts` — Previously deleted page restored when it reappears

**Estimated effort:** 1-2h (Parts A+B), +1h if Part C included

---

### Issue #35 — Status label: expanded UX scope

**Audit finding:** Core round-trip conversion **already works correctly**:
- `confluenceToHtml()` → `<span class="confluence-status" data-color="green">DONE</span>`
- TipTap `ConfluenceStatus.parseHTML()` matches `span.confluence-status`, reads `data-color` + textContent
- `htmlToConfluence()` reverses back to `ac:structured-macro[name=status]` with capitalized color
- **6 tests pass** (3 backend: forward/round-trip/markdown, 2 frontend: node/parseHTML, 1 integration)

**Expanded scope** (since core conversion is done):

1. **Status badge styling polish** — Improve visual rendering in both editor and viewer:
   - Color-coded background pills (not just text color)
   - Consistent styling between editor atom node and ArticleViewer rendered HTML
   - Dark mode support for all 5 colors

2. **Inline editing** — Click a status badge to edit its text/color:
   - Currently requires deleting and re-inserting to change
   - Add click handler on the atom node that opens a popover with color picker + text input
   - Similar pattern to the existing insert UI (which already has a color picker + label input)

3. **Slash command** — Add `/status` to the editor's slash command menu:
   - Verify if this already exists or needs to be added
   - Should open the same color picker + label input popover

4. **ArticleViewer rendering** — Verify status badges render correctly in read-only view:
   - Check that `ArticleViewer.tsx` CSS styles match the editor rendering
   - Test all 5 colors in both light and dark themes

**Files:** `article-extensions.ts` (NodeView for inline editing), `Editor.tsx` (slash command), `index.css` or component styles (badge styling), `ArticleViewer.tsx` (verify rendering) + tests

**Estimated effort:** 2-3h

---

## Sprint 2: Self-contained Editor Features (#17, #10) — ~1 day

### Issue #17 — Clipboard image paste

**Detailed plan in `IMPLEMENTATION-PLAN-DEFERRED-ISSUES.md` Sprint 1.**

Summary:
- Add `handlePaste` + `handleDrop` to `Editor.tsx` editorProps
- Detect `clipboardData.items` with `type.startsWith('image/')`
- Upload via new `POST /api/pages/:pageId/images` endpoint
- `@fastify/multipart` v9.4.0 **already installed** (audit confirmed)
- `@tiptap/extension-file-handler` not needed — native `handlePaste` suffices
- Insert image node at cursor position
- Supports PNG, JPG, GIF, WebP (max 10MB)

**Key caveat:** Needs `pageId` context — paste only works on saved pages. Show toast if attempted on unsaved page.

**Files:** `Editor.tsx`, `pages-crud.ts` (new endpoint) + tests
**Estimated effort:** 2-3h

---

### Issue #10 — Header numbering toggle

**Detailed plan in `IMPLEMENTATION-PLAN-DEFERRED-ISSUES.md` Sprint 2.**

Summary:
- CSS counters on `.header-numbering` class for H1/H2/H3 (hierarchical: 1, 1.1, 1.2, 2, 2.1)
- Toggle button in editor toolbar, persisted in localStorage
- Applied to both Editor and ArticleViewer containers
- Visual only — does not modify heading content

**Files:** `index.css`, `Editor.tsx`, `ArticleViewer.tsx` + tests
**Estimated effort:** 1-2h

---

## Sprint 3: Code Block Enhancement (#34) — ~0.5-1 day

### Issue #34 — Code block language selector + auto-detection

**Current state (audit confirmed):**
- `TitledCodeBlock` extends `CodeBlockLowlight` at `TitledCodeBlock.ts` — preserves `data-title`
- `lowlight` v3 initialized with `common` grammars (37 languages) via `createLowlight(common)` in `frontend/src/shared/lib/lowlight.ts`
- Language set only via markdown syntax (` ```js `). **No UI selector.**
- `lowlight.highlightAuto()` available but not used
- Confluence round-trip for language param already works

**Changes required:**

1. **`frontend/src/shared/components/article/CodeBlockNodeView.tsx`** (new file)

   React NodeView component for code blocks:
   - Floating header bar showing current language (or "Plain text")
   - Combobox populated from `lowlight.listLanguages()` (37 common languages)
   - Selecting a language calls `updateAttributes({ language: selected })`
   - "Auto-detect" option calls `lowlight.highlightAuto(node.textContent)` and sets detected language with "(detected)" label
   - Copy button in the header bar
   - Title display when `data-title` attribute present

   Follow existing pattern from `MermaidBlockExtension.tsx` (uses `ReactNodeViewRenderer`).

2. **`frontend/src/shared/components/article/TitledCodeBlock.ts`** — Register NodeView
   ```typescript
   addNodeView() {
     return ReactNodeViewRenderer(CodeBlockNodeView);
   }
   ```

3. **`frontend/src/shared/lib/lowlight.ts`** — Export language list
   ```typescript
   export const supportedLanguages = lowlight.listLanguages();
   ```

4. **`frontend/src/shared/components/article/Editor.tsx`** — Auto-detect on paste into code block
   - If paste target is a code block with no language set
   - Call `lowlight.highlightAuto(pastedText)`
   - If `relevance > 5`, set detected language via `updateAttributes`

5. **`frontend/src/index.css`** — Code block header styles

**Confluence compatibility:** No changes needed — `language` attribute already round-trips via content converter.

**Linting:** Deferred to separate issue. Language selector + auto-detection provide the foundation.

**Tests:** `CodeBlockNodeView.test.tsx` — dropdown renders, selection updates, auto-detect triggers
**Estimated effort:** 3-4h

---

## Sprint 4: Interactive Confluence Macros (#24, #25) — ~1.5 days

### Issue #24 — Confluence Attachments macro support

**Audit correction:** The attachments macro currently **falls through to UnknownMacro catch-all** and is rendered as `<div class="confluence-macro-unknown" data-macro-name="attachments">`. All parameters are lost. **Converter work IS required.**

**Changes required:**

1. **`backend/src/core/services/content-converter.ts`** — Add attachments macro handler

   In `confluenceToHtml()`, add case before unknown macro catch-all:
   ```typescript
   case 'attachments': {
     const upload = getParamValue(macro, 'upload') ?? 'false';
     const old = getParamValue(macro, 'old') ?? 'false';
     const div = doc.createElement('div');
     div.className = 'confluence-attachments-macro';
     div.setAttribute('data-upload', upload);
     div.setAttribute('data-old', old);
     div.textContent = '[Attachments]';
     macro.replaceWith(div);
     break;
   }
   ```

   In `htmlToConfluence()`, add reverse conversion:
   ```typescript
   for (const div of doc.querySelectorAll('div.confluence-attachments-macro')) {
     // → <ac:structured-macro ac:name="attachments"> with params
   }
   ```

2. **`frontend/src/shared/components/article/article-extensions.ts`** — New `ConfluenceAttachments` TipTap node
   - Atom block, parseHTML matches `div.confluence-attachments-macro`
   - Preserves `data-upload`, `data-old` attributes

3. **`frontend/src/shared/components/article/AttachmentsMacroView.tsx`** (new) — React NodeView
   - Fetches `GET /api/attachments/{pageId}` (new endpoint)
   - Renders file table: filename (icon), size, download link
   - Loading skeleton, empty state

4. **`backend/src/routes/confluence/attachments.ts`** — New list endpoint
   - `GET /api/attachments/:pageId` (no filename = list mode)
   - Read directory listing from `data/attachments/{pageId}/`
   - Return `{ attachments: [{ filename, size, mimeType, url }] }`

5. **`frontend/src/shared/components/article/Editor.tsx`** — Register extension + toolbar button (Paperclip icon)

**Tests:** Round-trip converter test, list endpoint test, NodeView render test
**Estimated effort:** 3-4h (increased from 2-3h due to converter work)

---

### Issue #25 — Confluence Children Pages macro support

**Audit confirmed:** `ConfluenceChildren` TipTap atom node **already exists** (`article-extensions.ts:285-314`) with 8 preserved attributes. Content converter **already handles** both `children` and `ui-children` macros. What's missing: live rendering + API endpoint.

**Changes required:**

1. **`frontend/src/shared/components/article/ChildrenMacroView.tsx`** (new) — React NodeView
   - Reads `data-sort`, `data-depth`, `data-reverse` from node attributes
   - Fetches `GET /api/pages/{pageId}/children?sort=...&depth=...`
   - Renders nested list of clickable page links
   - Empty state, loading skeleton

2. **`backend/src/routes/knowledge/pages-crud.ts`** — New endpoint
   - `GET /api/pages/:pageId/children` (audit confirmed: **does not exist**, only `has-children` boolean check exists)
   - Query `pages WHERE parent_id = :confluenceId AND deleted_at IS NULL`
   - Support sort (title|created_at), order (asc|desc), depth (1-3)
   - Recursive fetch for depth > 1

3. **`frontend/src/shared/components/article/Editor.tsx`** — Register NodeView + toolbar button (ListTree icon)

4. **`frontend/src/shared/components/article/ArticleViewer.tsx`** — Register NodeView for read mode

**Tests:** Children endpoint test, NodeView render test
**Estimated effort:** 2-3h

---

## Sprint 5: Captions + Index (#13) — ~1.5 days

### Issue #13 — Image/table captions and auto-generated figure & table index

**Detailed plan in `IMPLEMENTATION-PLAN-DEFERRED-ISSUES.md` Sprint 5.**

**Part A: Captions**
- New `Figure` node (wraps image + figcaption)
- New `Figcaption` node (editable inline content)
- New `TableCaption` node (after table)
- CSS counters for auto-numbering: "Figure 1:", "Table 1:"
- "Add caption" action on image hover menu and table context toolbar

**Part B: Index Blocks**
- New `FigureIndex` and `TableIndex` atom nodes
- NodeView components scanning document for figures/tables → rendered linked list
- Reactive updates via `editor.on('update', ...)`
- Slash commands to insert

**Confluence round-trip:** `<figure>/<figcaption>` pass through as HTML. Index blocks stripped on Confluence export.

**Files:** `article-extensions.ts`, `Editor.tsx`, `index.css`, `FigureIndexView.tsx` (new), `TableIndexView.tsx` (new), `content-converter.ts` + tests
**Estimated effort:** 4-6h

---

## Dependency Graph

```
#35 (Status UX polish)        ─── depends on #6 (CLOSED ✓), core conversion done ✓
#33 (Deletion/move sync)      ─── no dependencies, investigate-first approach
#17 (Clipboard paste)          ─── no dependencies
#10 (Header numbering)         ─── no dependencies
#34 (Code block selector)      ─── no dependencies
#24 (Attachments macro)        ─── no dependencies (needs converter + TipTap node + API)
#25 (Children Pages macro)     ─── no dependencies (TipTap node exists, needs NodeView + API)
#13 (Captions + index)         ─── no dependencies (benefits from #17 being done first)
```

All 8 issues are independently implementable.

---

## Total File Change Summary

| File | Sprints | Type |
|------|---------|------|
| `backend/src/domains/confluence/services/sync-service.ts` | 1 | Modify |
| `backend/src/core/services/content-converter.ts` | 4 | Modify |
| `backend/src/routes/knowledge/pages-crud.ts` | 2, 4 | Modify |
| `backend/src/routes/confluence/attachments.ts` | 4 | Modify |
| `frontend/src/shared/components/article/Editor.tsx` | 1, 2, 3, 4, 5 | Modify |
| `frontend/src/shared/components/article/ArticleViewer.tsx` | 2, 4 | Modify |
| `frontend/src/shared/components/article/article-extensions.ts` | 1, 4, 5 | Modify |
| `frontend/src/shared/components/article/TitledCodeBlock.ts` | 3 | Modify |
| `frontend/src/shared/lib/lowlight.ts` | 3 | Modify |
| `frontend/src/index.css` | 2, 3, 5 | Modify |
| `frontend/src/shared/components/article/CodeBlockNodeView.tsx` | 3 | **New** |
| `frontend/src/shared/components/article/AttachmentsMacroView.tsx` | 4 | **New** |
| `frontend/src/shared/components/article/ChildrenMacroView.tsx` | 4 | **New** |
| `frontend/src/shared/components/article/FigureIndexView.tsx` | 5 | **New** |
| `frontend/src/shared/components/article/TableIndexView.tsx` | 5 | **New** |

**New files:** 5 frontend components (no new SQL migrations needed — `deleted_at` already exists)
**Modified files:** 10

---

## Revised Estimates

| Sprint | Issues | Effort | Notes |
|--------|--------|--------|-------|
| 1 | #33, #35 | 3-5h | #33 reduced (infra exists), #35 expanded (UX polish) |
| 2 | #17, #10 | 3-5h | Unchanged |
| 3 | #34 | 3-4h | Unchanged |
| 4 | #24, #25 | 5-7h | #24 increased (converter work needed) |
| 5 | #13 | 4-6h | Unchanged |
| **Total** | **8 issues** | **~18-27h (~4-5 working days)** |

---

## References

- Existing detailed plans: `docs/IMPLEMENTATION-PLAN-DEFERRED-ISSUES.md` (covers #10, #13, #17, #24, #25)
- Previous action plan: `docs/ACTION-PLAN-ISSUES.md` (covers all 20 original issues)
- TipTap v3 Node API: https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node
- TipTap FileHandler: https://tiptap.dev/docs/editor/extensions/functionality/filehandler
- TipTap CodeBlockLowlight: https://tiptap.dev/docs/editor/extensions/nodes/code-block-lowlight
- lowlight v3 API (highlightAuto, listLanguages): https://github.com/wooorm/lowlight
- Confluence REST API v1 (DC 9.2): `/rest/api/content` with `expand=ancestors` for move detection
- Migration 029: `deleted_at` column + partial index on `pages` table
