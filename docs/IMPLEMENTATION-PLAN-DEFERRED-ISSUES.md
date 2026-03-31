# Implementation Plan: Issues #10, #13, #17, #24, #25

## Sprint Order

| Sprint | Issue | Title | Complexity | Est. |
|--------|-------|-------|------------|------|
| 1 | #17 | Clipboard image paste | Medium | 2-3h |
| 2 | #10 | Header numbering toggle | Low | 1-2h |
| 3 | #24 | Confluence Attachments macro | Medium | 2-3h |
| 4 | #25 | Confluence Children Pages macro | Medium | 2-3h |
| 5 | #13 | Image/table captions + index | High | 4-6h |

**Rationale**: #17 and #10 are self-contained editor features with no new backend work. #24 and #25 build on existing content converter patterns. #13 is the most complex (new TipTap nodes + dynamic numbering).

---

## Sprint 1: #17 — Clipboard Image Paste

### What exists
- `ConfluenceImage` TipTap extension in `Editor.tsx:41-82` with Confluence metadata attributes
- Image insertion via manual URL prompt (`window.prompt`) in toolbar
- Attachment storage at `data/attachments/{pageId}/{filename}` via `attachment-handler.ts`
- PUT `/api/attachments/:pageId/:filename` accepts `{ dataUri }` for draw.io edits

### Changes required

**Frontend (2 files)**

1. **`frontend/src/shared/components/article/Editor.tsx`** — Add paste handler to editor config

   In the `useEditor` config (around line 740), add an `editorProps.handlePaste` handler:
   ```typescript
   editorProps: {
     handlePaste(view, event) {
       const items = Array.from(event.clipboardData?.items ?? []);
       const imageItem = items.find(i => i.type.startsWith('image/'));
       if (!imageItem) return false; // let TipTap handle non-image paste

       event.preventDefault();
       const file = imageItem.getAsFile();
       if (!file) return false;

       // Upload via new endpoint, insert on success
       uploadPastedImage(file, pageId).then(url => {
         editor.chain().focus().setImage({ src: url }).run();
       });
       return true;
     },
   }
   ```

   Add `uploadPastedImage()` helper function that:
   - Reads file as data URI via `FileReader`
   - POSTs to new endpoint `/api/pages/:pageId/images`
   - Returns the served URL `/api/attachments/{pageId}/{filename}`

2. **`frontend/src/shared/components/article/Editor.tsx`** — Also handle drop events

   Add `handleDrop` in the same `editorProps` for drag-and-drop image support (same upload logic).

**Backend (2 files)**

3. **`backend/src/routes/knowledge/pages-crud.ts`** — New endpoint for image upload

   Add `POST /api/pages/:pageId/images`:
   - Accept multipart file or JSON `{ dataUri, filename }` 
   - Validate: image MIME type (png, jpg, gif, webp), max 10MB
   - Generate unique filename: `paste-{timestamp}-{random}.{ext}`
   - Write to `data/attachments/{pageId}/{filename}` via `writeAttachmentCache()`
   - Return `{ url: '/api/attachments/{pageId}/{filename}' }`
   - Auth required (`fastify.authenticate`)

4. **`backend/src/routes/knowledge/pages-crud.ts`** — Register multipart support

   Ensure `@fastify/multipart` is available for this route (already installed for other uses — verify).

**Tests (2 files)**

5. **`frontend/src/shared/components/article/Editor.test.tsx`** — Test paste handler
   - Mock `clipboardData.items` with image blob
   - Verify upload function called
   - Verify `setImage` chain called with returned URL

6. **`backend/src/routes/knowledge/pages-crud.test.ts`** — Test image upload endpoint
   - POST with valid image data URI → 200 + URL
   - POST with non-image MIME → 400
   - POST without auth → 401

### Rollback
- Remove `handlePaste`/`handleDrop` from editorProps
- Remove POST `/api/pages/:pageId/images` route

---

## Sprint 2: #10 — Header Numbering Toggle

### What exists
- `StarterKit` provides heading nodes (H1-H3 tracked in `activeState`)
- No CSS counters or numbering currently
- `ConfluenceToc` extension exists (TOC placeholder) — related but separate

### Changes required

**Frontend (3 files)**

1. **`frontend/src/index.css`** — Add CSS counter rules

   ```css
   /* Header numbering — activated by .header-numbering class on editor/viewer container */
   .header-numbering {
     counter-reset: h1-counter;
   }
   .header-numbering h1 { counter-reset: h2-counter; counter-increment: h1-counter; }
   .header-numbering h2 { counter-reset: h3-counter; counter-increment: h2-counter; }
   .header-numbering h3 { counter-increment: h3-counter; }

   .header-numbering h1::before { content: counter(h1-counter) ". "; }
   .header-numbering h2::before { content: counter(h1-counter) "." counter(h2-counter) " "; }
   .header-numbering h3::before { content: counter(h1-counter) "." counter(h2-counter) "." counter(h3-counter) " "; }

   /* Style the counters */
   .header-numbering h1::before,
   .header-numbering h2::before,
   .header-numbering h3::before {
     color: var(--color-muted-foreground);
     font-weight: normal;
   }
   ```

2. **`frontend/src/shared/components/article/Editor.tsx`** — Add toggle button to toolbar

   Add a toolbar button (e.g. `ListOrdered` icon) that toggles a `headerNumbering` state:
   ```typescript
   const [headerNumbering, setHeaderNumbering] = useState(() =>
     localStorage.getItem('editor-header-numbering') === 'true'
   );
   const toggleHeaderNumbering = () => {
     setHeaderNumbering(prev => {
       localStorage.setItem('editor-header-numbering', String(!prev));
       return !prev;
     });
   };
   ```
   Apply `header-numbering` CSS class to the editor container `div` when enabled.

3. **`frontend/src/shared/components/article/ArticleViewer.tsx`** — Apply same class in view mode

   Read the same localStorage key and apply `header-numbering` class to the viewer container.

**Tests (1 file)**

4. **`frontend/src/shared/components/article/Editor.test.tsx`** — Test toggle
   - Toggle button exists
   - Clicking toggles `header-numbering` class on container
   - Persists to localStorage

### Rollback
- Remove CSS counter rules from `index.css`
- Remove toggle state and button from Editor/ArticleViewer

---

## Sprint 3: #24 — Confluence Attachments Macro

### What exists
- Content converter already handles 12+ Confluence macros with established patterns
- `UnknownMacro` catch-all currently captures unhandled macros
- Attachment data available via `GET /api/attachments/:pageId/:filename`
- `attachment-handler.ts` has `getExpectedAttachmentFilenames()` to list attachments
- No dedicated endpoint to list all attachments for a page with metadata

### Changes required

**Backend (2 files)**

1. **`backend/src/core/services/content-converter.ts`** — Add attachments macro conversion

   In `confluenceToHtml()`, add handler for `ac:structured-macro[name=attachments]`:
   ```typescript
   // Attachments macro → placeholder div (data fetched at render time)
   case 'attachments':
     const upload = getParam('upload') ?? 'false';
     const old = getParam('old') ?? 'false';
     el.replaceWith(`<div class="confluence-attachments-macro" data-upload="${upload}" data-old="${old}"></div>`);
     break;
   ```

   In `htmlToConfluence()`, reverse:
   ```typescript
   // .confluence-attachments-macro → ac:structured-macro
   $('div.confluence-attachments-macro').each((_, el) => { ... });
   ```

2. **`backend/src/routes/confluence/attachments.ts`** — New endpoint to list attachments

   Add `GET /api/attachments/:pageId` (no filename = list mode):
   - Query `cached_pages` for the page to get `confluence_page_id`
   - Read attachment directory listing from `data/attachments/{pageId}/`
   - Return `{ attachments: [{ filename, size, mimeType, url }] }`
   - Fall back to empty array if no directory exists

**Frontend (3 files)**

3. **`frontend/src/shared/components/article/article-extensions.ts`** — Add `ConfluenceAttachments` node

   Already has `ConfluenceChildren` as a pattern. Create similar:
   ```typescript
   export const ConfluenceAttachments = Node.create({
     name: 'confluenceAttachments',
     group: 'block',
     atom: true,
     parseHTML() {
       return [{ tag: 'div.confluence-attachments-macro' }];
     },
     renderHTML({ HTMLAttributes }) {
       return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-attachments-macro' }), 0];
     },
   });
   ```

4. **`frontend/src/shared/components/article/AttachmentsMacroView.tsx`** — New component

   React component rendered as a TipTap NodeView:
   - Fetches `GET /api/attachments/{pageId}` on mount
   - Renders table: filename (with icon), size, download link
   - Shows "No attachments" placeholder when empty
   - Loading state with skeleton

5. **`frontend/src/shared/components/article/Editor.tsx`** — Register extension + toolbar button

   - Add `ConfluenceAttachments` to extensions array
   - Add toolbar button (Paperclip icon) to insert attachments block:
     ```typescript
     editor.chain().focus().insertContent({ type: 'confluenceAttachments' }).run()
     ```

**Tests (3 files)**

6. **`backend/src/core/services/content-converter.test.ts`** — Round-trip test for attachments macro
7. **`frontend/src/shared/components/article/article-extensions.test.ts`** — Parse test
8. **`backend/src/routes/confluence/attachments.test.ts`** — List endpoint test

### Rollback
- Remove macro handler from content-converter
- Remove `ConfluenceAttachments` extension and NodeView
- Remove list endpoint

---

## Sprint 4: #25 — Confluence Children Pages Macro

### What exists (IMPORTANT: already partially done)
- **`ConfluenceChildren` TipTap node** already exists in `article-extensions.ts` — preserves all params (sort, reverse, depth, first, page, style, excerptType, macro-name)
- **Content converter** already handles `children` and `ui-children` macros with full round-trip support
- **`parent_id`** field in `cached_pages` table with index
- **`subpage-context.ts`** has `fetchSubPages()` helper
- **What's missing**: live rendering of child pages in the viewer/editor (currently just a placeholder div)

### Changes required

**Backend (1 file)**

1. **`backend/src/routes/knowledge/pages-crud.ts`** — New endpoint for child pages

   Add `GET /api/pages/:pageId/children`:
   - Query `cached_pages WHERE parent_id = :pageId AND user_id = :userId`
   - Support query params: `sort` (title|created_at), `order` (asc|desc), `depth` (1-3), `limit`
   - Return `{ children: [{ id, title, url_slug, created_at, children?: [...] }] }`
   - Recursive fetch for depth > 1

**Frontend (2 files)**

2. **`frontend/src/shared/components/article/ChildrenMacroView.tsx`** — New component

   React component rendered as TipTap NodeView for `ConfluenceChildren`:
   - Reads `data-sort`, `data-depth`, `data-reverse` attributes from the node
   - Fetches `GET /api/pages/{pageId}/children?sort=...&depth=...`
   - Renders nested list of clickable page links (`<a>` with router navigation)
   - Shows "No child pages" when empty
   - Respects `data-style` attribute for heading level display

3. **`frontend/src/shared/components/article/Editor.tsx`** — Add NodeView rendering + toolbar button

   - Register `ConfluenceChildren` with `addNodeView()` pointing to `ChildrenMacroView`
   - Add toolbar button (ListTree icon) to insert children macro block
   - Also register in `ArticleViewer.tsx` for read-mode rendering

**Tests (2 files)**

4. **`backend/src/routes/knowledge/pages-crud.test.ts`** — Test children endpoint
5. **`frontend/src/shared/components/article/ChildrenMacroView.test.tsx`** — Render test

### Rollback
- Remove NodeView registration (keep the existing TipTap node — it was already there)
- Remove GET children endpoint
- Remove `ChildrenMacroView` component

---

## Sprint 5: #13 — Image/Table Captions + Index

### What exists
- `ConfluenceImage` extension handles images with metadata
- `Table` extension from TipTap with resizable columns
- No caption/figure support currently
- No figure/table numbering system

### Changes required

This is the most complex feature. Two sub-features: (A) captions on images/tables, (B) auto-generated index blocks.

### Part A: Captions

**Frontend (3 files)**

1. **`frontend/src/shared/components/article/article-extensions.ts`** — New `Figure` and `TableCaption` nodes

   **Figure node** (wraps image + caption):
   ```typescript
   export const Figure = Node.create({
     name: 'figure',
     group: 'block',
     content: 'confluenceImage figcaption',
     parseHTML() { return [{ tag: 'figure' }]; },
     renderHTML() { return ['figure', 0]; },
   });

   export const Figcaption = Node.create({
     name: 'figcaption',
     group: 'block',
     content: 'inline*',
     parseHTML() { return [{ tag: 'figcaption' }]; },
     renderHTML() { return ['figcaption', { class: 'text-sm text-muted-foreground text-center mt-1' }, 0]; },
   });
   ```

   **TableCaption node** (inserted after table):
   ```typescript
   export const TableCaption = Node.create({
     name: 'tableCaption',
     group: 'block',
     content: 'inline*',
     parseHTML() { return [{ tag: 'caption' }, { tag: '.table-caption' }]; },
     renderHTML() { return ['div', { class: 'table-caption text-sm text-muted-foreground text-center mt-1' }, 0]; },
   });
   ```

2. **`frontend/src/shared/components/article/Editor.tsx`** — Register extensions + commands

   - Register `Figure`, `Figcaption`, `TableCaption`
   - Add "Add caption" option to image node view (right-click or hover menu)
   - Add "Add caption" option to `TableContextToolbar`
   - Wrap existing image in `<figure>` when caption added

3. **`frontend/src/index.css`** — Caption numbering via CSS counters

   ```css
   .ProseMirror { counter-reset: figure-counter table-counter; }
   .ProseMirror figure { counter-increment: figure-counter; }
   .ProseMirror figure figcaption::before { content: "Figure " counter(figure-counter) ": "; font-weight: 600; }
   .ProseMirror .table-caption { counter-increment: table-counter; }
   .ProseMirror .table-caption::before { content: "Table " counter(table-counter) ": "; font-weight: 600; }
   ```

### Part B: Index Blocks

**Frontend (2 files)**

4. **`frontend/src/shared/components/article/article-extensions.ts`** — New `FigureIndex` and `TableIndex` nodes

   ```typescript
   export const FigureIndex = Node.create({
     name: 'figureIndex',
     group: 'block',
     atom: true,
     parseHTML() { return [{ tag: 'div.figure-index' }]; },
     renderHTML() { return ['div', { class: 'figure-index' }, 0]; },
   });
   ```
   (Same pattern for `TableIndex`)

5. **`frontend/src/shared/components/article/FigureIndexView.tsx`** — NodeView component

   - Scans the editor document for all `figure` nodes with `figcaption` content
   - Renders "List of Figures" with numbered entries
   - Updates reactively when document changes (use `editor.on('update', ...)`)
   - Same approach for `TableIndexView.tsx`

**Backend (1 file)**

6. **`backend/src/core/services/content-converter.ts`** — Handle figure/caption in conversion

   - `<figure>` and `<figcaption>` pass through as standard HTML (no Confluence equivalent)
   - For Confluence round-trip: store captions as `<!-- caption: ... -->` HTML comments or data attributes on images
   - Index blocks: strip during Confluence export (they're auto-generated)

**Tests (3 files)**

7. **`frontend/src/shared/components/article/article-extensions.test.ts`** — Figure, Figcaption, TableCaption, FigureIndex, TableIndex parse tests
8. **`frontend/src/shared/components/article/FigureIndexView.test.tsx`** — Index rendering test
9. **`backend/src/core/services/content-converter.test.ts`** — Figure/caption round-trip test

### Rollback
- Remove Figure, Figcaption, TableCaption, FigureIndex, TableIndex extensions
- Remove CSS counter rules
- Remove NodeView components
- Remove content converter additions

---

## File Change Summary

| File | Sprints | Changes |
|------|---------|---------|
| `frontend/src/shared/components/article/Editor.tsx` | 1,2,3,4,5 | Paste handler, numbering toggle, new extensions, toolbar buttons |
| `frontend/src/shared/components/article/ArticleViewer.tsx` | 2,4 | Numbering class, children NodeView |
| `frontend/src/shared/components/article/article-extensions.ts` | 3,5 | ConfluenceAttachments, Figure, Figcaption, TableCaption, FigureIndex, TableIndex |
| `frontend/src/index.css` | 2,5 | CSS counters for headers, figures, tables |
| `frontend/src/shared/components/article/AttachmentsMacroView.tsx` | 3 | New file |
| `frontend/src/shared/components/article/ChildrenMacroView.tsx` | 4 | New file |
| `frontend/src/shared/components/article/FigureIndexView.tsx` | 5 | New file |
| `frontend/src/shared/components/article/TableIndexView.tsx` | 5 | New file |
| `backend/src/core/services/content-converter.ts` | 3,5 | Attachments macro, figure/caption handling |
| `backend/src/routes/knowledge/pages-crud.ts` | 1,4 | Image upload endpoint, children endpoint |
| `backend/src/routes/confluence/attachments.ts` | 3 | List attachments endpoint |

**Total new files**: 4
**Total modified files**: 7
