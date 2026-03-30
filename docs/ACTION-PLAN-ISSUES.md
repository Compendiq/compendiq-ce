# Action Plan: Open Issues Implementation

20 open issues. Validated against codebase audit + TipTap v3 docs (2026-03-30).

## Corrections from Research

Several issues reference features that **already exist** in the codebase. The real work
is different from what the issue titles suggest:

| Issue | Title Says | Codebase Reality |
|-------|-----------|-----------------|
| **#16** | Toolbar should reflect active formatting | `editor.isActive()` already used on all 14 toolbar buttons (`Editor.tsx:125-211`) |
| **#11** | Show table options when clicking in table | `TableContextToolbar` already exists (`Editor.tsx:214-383`) with add/delete row/col, merge/split |
| **#18** | Add keyboard shortcuts | StarterKit v3 already provides Ctrl+B/I/U, code block, blockquote, lists. Page shortcuts exist too. |
| **#6** | Add Status Label support | `ConfluenceStatus` TipTap node already exists (`article-extensions.ts:246-279`). Backend converter handles round-trip. |
| **#7** | Add Expand/Collapse support | `Details` + `DetailsSummary` nodes already exist (`article-extensions.ts:39-90`). Backend converter handles round-trip. |
| **#9** | Drag handle (claimed Pro-only) | `@tiptap/extension-drag-handle` is a **free community extension** in TipTap v3. No Pro license needed. |
| **#22** | "Page not found" on AI save | Code flow looks correct: `pageId` (confluenceId) used consistently frontend→backend→DB. May be standalone-page specific or intermittent. |
| **#24/#25** | Confluence macro support | Backend converter already handles `children` (placeholder div) and `attachments` (via image refs). Issue is about **interactive rendering**, not parsing. |

---

## Sprint 1: Bugs (Issues: #22, #8, #12, #23)

**Goal:** Fix confirmed user-facing bugs.

| # | Title | Type | Effort | Notes |
|---|-------|------|--------|-------|
| **#22** | "Page not found" on AI save | bug | M | Needs reproduction — code path looks correct for Confluence pages. **Suspect:** standalone pages use internal `id` (integer) but AI save sends `confluenceId` (null for standalone). Check `ImproveMode.tsx:63` `pageId` when `page.source === 'standalone'`. |
| **#8** | Wide tables scroll entire article | bug | S | No `overflow-x: auto` on table wrappers. Add to `ArticleViewer.tsx` and editor prose CSS. |
| **#12** | No resize cursor on table column borders | bug | XS | CSS only: add `cursor: col-resize` to `.column-resize-handle` in editor styles. |
| **#23** | Center search bar in top nav | enhancement | XS | CSS flex change in the top bar layout component. |

### Implementation Notes

**#22 — Root cause investigation needed:**
- `ImproveMode.tsx:63` sends `pageId` which comes from `searchParams.get('pageId')`.
- For Confluence pages, `pageId` = confluenceId string, backend does `WHERE confluence_id = $1` — correct.
- For **standalone pages**, there is no `confluenceId`. The URL may pass the internal integer ID, but backend queries `WHERE confluence_id = $1` which won't match an integer ID.
- **Fix:** Backend `POST /api/llm/improvements/apply` should try both `confluence_id` and `id` lookup, or the frontend should send the correct identifier type.

**#8 — Table overflow:**
- Add `overflow-x: auto; max-width: 100%` wrapper around `<table>` elements in both `ArticleViewer.tsx` (read mode) and the TipTap editor prose styles.
- Target: `frontend/src/shared/components/article/ArticleViewer.tsx` and `frontend/src/index.css` (ProseMirror table styles).

---

## Sprint 2: Editor UX Polish (Issues: #16, #11, #18, #19)

**Goal:** Fix discoverability of existing features + add missing shortcuts.

| # | Title | Type | Effort | Notes |
|---|-------|------|--------|-------|
| **#16** | Toolbar active state | bug | S | `editor.isActive()` IS used, but issue may be about **visual styling** — the `active` prop may not have sufficient visual contrast. Check `ToolbarButton` component CSS. |
| **#11** | Table options visibility | bug | S | `TableContextToolbar` EXISTS but may not be **visible enough** — check if it renders below the fold or if the conditional show logic has a bug. Verify `editor.isActive('table')` triggers correctly. |
| **#18** | Keyboard shortcuts | enhancement | S | Most already work via StarterKit. **Gap:** Ctrl+Shift+1-6 for headings, Ctrl+Shift+H for highlight (needs #14 first), Ctrl+Shift+S for strikethrough. Add missing shortcuts + document all in a help modal or tooltip. |
| **#19** | Remove layout row | enhancement | S | The page layout component needs a delete button per row. Find the layout grid component in the editor. |

### Implementation Notes

**#16 — Toolbar visual feedback:**
- `ToolbarButton` receives `active` boolean prop. Check that the active state has visible styling (e.g., `bg-accent`, `text-accent-foreground`, or a ring). The `isActive()` logic is correct — the issue is likely CSS contrast.

**#11 — Table toolbar discoverability:**
- `TableContextToolbar` renders at `Editor.tsx:560`. Verify it appears when cursor is inside a table cell. The component uses `editor.isActive('table')` as guard. May need to render **above** the table (floating) instead of inline.

---

## Sprint 3: New Editor Features (Issues: #14, #15, #9, #17, #10)

**Goal:** Add genuinely missing features confirmed by codebase audit.

| # | Title | Type | Effort | Notes |
|---|-------|------|--------|-------|
| **#14** | Text highlight with color | enhancement | M | `@tiptap/extension-highlight` NOT installed. Need to add package + toolbar color picker. |
| **#15** | Text font color | enhancement | M | `@tiptap/extension-color` + `@tiptap/extension-text-style` NOT installed. |
| **#9** | Drag handles on all blocks | enhancement | M | `@tiptap/extension-drag-handle` is FREE in v3 (not Pro). `npm install @tiptap/extension-drag-handle`. `@dnd-kit` already installed as fallback. |
| **#17** | Clipboard image paste | enhancement | M | Backend upload endpoint EXISTS (`PUT /api/attachments/:pageId/:filename`). Frontend only has URL prompt. Need `handlePaste` in editor for image/* clipboard data. |
| **#10** | Header numbering toggle | enhancement | M | CSS counters on heading levels + toggle in editor settings/toolbar. |

### Implementation Notes

**#14/#15 — Color extensions (TipTap v3 docs verified):**
```bash
npm install @tiptap/extension-highlight @tiptap/extension-color @tiptap/extension-text-style
```
- `Highlight.configure({ multicolor: true })` — enables per-color highlights.
- Built-in shortcut: `Ctrl+Shift+H` for highlight.
- Add `ColorHighlightPopover` UI component to toolbar (or build custom color picker with Radix Popover).
- `Color` extension + `TextStyle` extension enable `editor.chain().setColor('#ff0000').run()`.

**#9 — Drag handles (TipTap v3 docs verified):**
```bash
npm install @tiptap/extension-drag-handle
```
- **NOT a Pro extension** — free in TipTap v3.
- Configure with `render()` for custom grip icon, `nested: true` for list items/blockquotes.
- Needs CSS: `padding-left: 2rem` on `.ProseMirror` for handle space.

**#17 — Clipboard image paste:**
- Use TipTap's `handlePaste` editor option (ProseMirror event handler).
- Detect `clipboardData.items` with `type.startsWith('image/')`.
- Upload blob to `PUT /api/attachments/:pageId/:filename` (max 10MB, already exists).
- Insert `editor.chain().setImage({ src: uploadedUrl }).run()`.
- **Caveat:** Needs a `pageId` context — clipboard paste only works when editing an existing page (not a new unsaved page).

---

## Sprint 4: AI Enhancements (Issues: #20, #21)

**Goal:** Improve AI UX with thinking mode and better feedback.

| # | Title | Type | Effort | Notes |
|---|-------|------|--------|-------|
| **#20** | LLM Thinking Mode toggle | enhancement | M | Frontend already tracks `isThinking` state + 2s timer. Backend needs `thinking` param in request schemas + system prompt injection. |
| **#21** | Redesign processing indicator | enhancement | M | Current indicator is oversized. Need compact version with status text from SSE events. |

### Implementation Notes

**#20 — Thinking mode (partially implemented):**
- **Frontend done:** `AiContext.tsx` already has `isThinking`, `setIsThinking`, `thinkingElapsed` (2s transition timer), and `ThinkingBlob` animation.
- **Backend missing:**
  1. Add `thinking?: boolean` to `AskRequestSchema`, `ImproveRequestSchema`, `GenerateRequestSchema`, `SummarizeRequestSchema` in `packages/contracts/src/schemas/llm.ts`.
  2. When `thinking: true`, prepend chain-of-thought instructions to system prompt (e.g., "Think step by step before answering. Show your reasoning.").
  3. For models with native thinking (Ollama with `think` parameter, or OpenAI o1), pass the model-specific parameter.
- **UI:** Add toggle switch on AI page, persist in localStorage or Zustand store.

---

## Sprint 5: Editor Insert Menus + Confluence Interactivity (Issues: #6, #7, #13, #24, #25)

**Goal:** Add insert toolbar entries for existing node types + interactive Confluence macro rendering.

| # | Title | Type | Effort | Notes |
|---|-------|------|--------|-------|
| **#6** | Status Label — insert button | enhancement | S | Node EXISTS. Need **toolbar insert button** with color picker (Green/Yellow/Red/Blue/Grey). |
| **#7** | Expand section — insert button | enhancement | S | Node EXISTS. Need **toolbar insert button** that creates `<details>` with default "Click to expand" summary. |
| **#13** | Image/table captions + index | enhancement | L | New feature — extend Image/Table nodes with caption field, auto-numbering plugin. |
| **#24** | Confluence Attachments — interactive | enhancement | M | Converter handles parsing. Need **interactive render** in `ArticleViewer`: fetch actual attachments from API and display file list. |
| **#25** | Confluence Children Pages — interactive | enhancement | M | Converter creates placeholder div. Need **interactive render** in `ArticleViewer`: fetch child pages from API and display page tree. |

### Implementation Notes

**#6/#7 — Insert buttons (nodes already exist):**
- `ConfluenceStatus` node exists at `article-extensions.ts:246-279`.
- `Details`/`DetailsSummary` nodes exist at `article-extensions.ts:39-90`.
- **Work needed:** Add "Insert Status" and "Insert Expand" buttons to the editor toolbar or a slash command menu. Status needs a color picker; Expand needs a title prompt.

**#24/#25 — Interactive macro rendering:**
- Backend converter already creates `<div class="confluence-children-macro">` with data attributes.
- `ArticleViewer.tsx` needs to intercept these placeholder divs and render React components that:
  - **Children:** Call `GET /api/pages?parentId=X` and render a linked page list.
  - **Attachments:** Call `GET /api/attachments/:pageId` and render a file table.

---

## Revised Summary

| Sprint | Issues | Effort | Focus |
|--------|--------|--------|-------|
| **1** | #22, #8, #12, #23 | 1 day | Confirmed bugs |
| **2** | #16, #11, #18, #19 | 1-2 days | UX polish (features mostly exist) |
| **3** | #14, #15, #9, #17, #10 | 3-4 days | New features (packages to install) |
| **4** | #20, #21 | 2 days | AI enhancements |
| **5** | #6, #7, #13, #24, #25 | 3-4 days | Insert menus + interactive macros |

**Total: ~10-13 days** (down from 15-20 in the unchecked plan)

**Recommended order:** Sprint 1 → 2 → 3 → 4 → 5

---

## Dependencies (Revised)

```
Sprint 1 (no deps):
  #22 ← needs reproduction first, then fix
  #8  ← CSS only
  #12 ← CSS only
  #23 ← CSS only

Sprint 2 (no deps):
  #16 ← verify ToolbarButton active styling
  #11 ← verify TableContextToolbar visibility
  #18 ← add missing shortcuts only (most work)
  #19 ← find layout component

Sprint 3:
  #14 ← npm install 3 packages + toolbar UI
  #15 ← same packages as #14, do together
  #9  ← npm install 1 package + CSS
  #17 ← needs page context (pageId) for upload
  #10 ← CSS counters + toggle state

Sprint 4 (no deps):
  #20 ← contracts schema change + backend + frontend toggle
  #21 ← frontend only

Sprint 5:
  #6  ← toolbar button for existing ConfluenceStatus node
  #7  ← toolbar button for existing Details node
  #13 ← new node extension work
  #24 ← needs attachment API endpoint (exists)
  #25 ← needs pages list API (exists)
```

---

## Key Packages to Install (Sprint 3)

```bash
npm install -w frontend \
  @tiptap/extension-highlight \
  @tiptap/extension-color \
  @tiptap/extension-text-style \
  @tiptap/extension-drag-handle
```

All are **free community extensions** in TipTap v3. No Pro license required.
