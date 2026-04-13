# Issue: Simplify hierarchy — remove folder page type, use regular pages with children instead

## Problem Statement

The app has a `pageType: 'folder'` concept for standalone/local pages that acts as a **content-free container**. But this creates confusion and unnecessary complexity because:

1. **Confluence doesn't have folders** — every Confluence page can have sub-pages. A page with children IS the "folder" — it's just a regular page.
2. **Pages with children already display as folders** — the sidebar shows a folder icon for ANY page with children (`isFolder || hasChildren` at `SidebarTreeView.tsx:180`), regardless of `pageType`.
3. **Folders can't have content** — creating a folder creates an empty page that rejects body updates (`pages-crud.ts:677-680`). But users might want to have an overview/index page that also has children.
4. **Dual display logic is confusing** — a page with `pageType='page'` that has children shows a folder icon AND is navigable. A page with `pageType='folder'` shows a folder icon but clicking only toggles expand. Two different behaviors for visually identical items.
5. **Extra complexity** — separate `pageType` column, creation flow, edit restrictions, view restrictions, all for something that could be achieved by just creating an empty page with children.

## Current Behavior

### Folder (`pageType = 'folder'`):
- Created via sidebar "New Folder" button
- `body_html = ''`, `body_text = ''`, `body_storage = NULL`
- **Cannot add content** — PUT rejects non-empty `bodyHtml` with 400 error
- Click in sidebar: only toggles expand/collapse, no navigation
- Page view: shows "This is a folder page" placeholder, no editor
- Edit button hidden

### Page with children (`pageType = 'page'`, has sub-pages):
- Created normally, content added via editor
- Has full `body_html` content
- Click in sidebar: navigates to article AND toggles expand
- Page view: shows full article content
- Edit button visible
- **Also shows folder icon** in sidebar (same as actual folders)

### The inconsistency:
```
Sidebar display (both look identical):
📂 Engineering Guide     ← pageType='folder', click only toggles
📂 API Documentation     ← pageType='page' with children, click navigates + toggles
📄 Setup Instructions    ← pageType='page' without children
```

Users expect clicking a folder icon to show its contents. With `pageType='page'` + children, they get navigated to the page content AND see children. With `pageType='folder'`, they get nothing — just a toggle.

## Proposal: Remove `pageType = 'folder'`, use empty pages instead

Replace the folder concept with **regular pages that happen to be empty**:

1. Remove the `folder` value from `page_type` constraint
2. When user clicks "New Folder" → create a regular page with empty body
3. Allow adding content to "folder-like" pages later (they're just pages)
4. The sidebar already shows folder icons for pages with children — no visual change needed
5. All pages become navigable, even if they're currently empty

### Benefits:
- **Simpler mental model** — every item is a page, some have children
- **Consistent with Confluence** — where every page can have sub-pages
- **Content can be added later** — an empty "folder" page can become an overview page
- **One click behavior** — clicking always navigates (and toggles if it has children)
- **Less code** — remove folder-specific guards, restrictions, and branching

## Affected Files

### Backend
- `backend/src/routes/knowledge/pages-crud.ts` — remove folder body rejection (lines 677-680), remove `isFolder` branching in POST (lines 547-550)
- `backend/src/core/db/migrations/` — new migration to remove `page_type` constraint or change default behavior
- `packages/contracts/src/schemas/pages.ts` — update `PageTypeEnum` or remove it

### Frontend
- `frontend/src/shared/components/layout/SidebarTreeView.tsx` — simplify click behavior (remove `isFolder` special case at lines 131-135), unify icon logic
- `frontend/src/features/pages/PageViewPage.tsx` — remove folder placeholder view (lines 497-517), remove edit button hide (line 457)
- `frontend/src/shared/components/LocationPicker.tsx` — icon logic already uses `hasChildren` (correct)
- `frontend/src/features/pages/NewPagePage.tsx` — no changes (doesn't handle folders)

### Tests
- Backend and frontend tests referencing `pageType: 'folder'`

## Implementation Plan

### Phase 1: Backend — remove folder body content restriction

Remove the guard that prevents adding content to folders in `pages-crud.ts`:

```diff
- // pages-crud.ts:677-680
- if (existingPage.page_type === 'folder' && body.bodyHtml && body.bodyHtml.trim() !== '') {
-   throw fastify.httpErrors.badRequest('Folder pages cannot have body content.');
- }
```

This immediately allows users to add content to existing folder pages.

### Phase 2: Backend — simplify page creation

Remove the `isFolder` branching in POST `/api/pages`:

```diff
- const isFolder = pageType === 'folder';
- const effectiveBodyHtml = isFolder ? '' : body.bodyHtml;
- const bodyText = isFolder ? '' : htmlToText(effectiveBodyHtml);
+ const effectiveBodyHtml = body.bodyHtml;
+ const bodyText = htmlToText(effectiveBodyHtml);
```

The "New Folder" action in the sidebar simply creates a page with empty `bodyHtml` — no special `pageType` needed.

### Phase 3: Frontend — unify sidebar click behavior

In `SidebarTreeView.tsx`, make all items navigable:

```diff
  const handleNavigate = useCallback(() => {
-   if (isFolder) {
-     // Folders are pure containers: toggle expand but don't navigate
-     toggleExpand(node.page.id);
-     return;
-   }
    if (hasChildren) toggleExpand(node.page.id);
    if (isAiRoute) {
      navigate(`/ai?pageId=${node.page.id}`, { replace: true });
    } else {
      navigate(`/pages/${node.page.id}`);
    }
  }, [...]);
```

### Phase 4: Frontend — remove folder placeholder in PageViewPage

Replace the folder-specific view with a normal empty page view:

```diff
- ) : page.pageType === 'folder' ? (
-   <div ...>
-     <FolderOpen ... />
-     <p>This is a folder page that acts as a container for child pages.</p>
-   </div>
+ ) : !page.bodyHtml?.trim() ? (
+   <div ...>
+     <p className="text-muted-foreground">This page has no content yet.</p>
+     <button onClick={handleStartEditing}>Add content</button>
+   </div>
```

Show edit button for ALL pages (remove the `page.pageType !== 'folder'` guard).

### Phase 5: Frontend — update "New Folder" to create empty page

In `SidebarTreeView.tsx`, change folder creation:

```diff
  await createPage.mutateAsync({
    spaceKey,
    title: trimmed,
    bodyHtml: '',
-   pageType: 'folder',
  });
```

The button label can stay as "New Folder" or be changed to "New Section" for clarity — it just creates an empty page as a container.

### Phase 6: Database migration

Add a migration to convert existing folders to regular pages:

```sql
-- Convert all existing folder pages to regular pages
UPDATE pages SET page_type = 'page' WHERE page_type = 'folder';

-- Remove the folder constraint (optional — or keep for backward compat)
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_page_type_check;
ALTER TABLE pages ADD CONSTRAINT pages_page_type_check CHECK (page_type IN ('page'));
```

Or alternatively, keep `page_type` column but stop using it for behavior branching — treat it as metadata only.

### Phase 7: Update contracts

In `packages/contracts/src/schemas/pages.ts`:

```diff
- export const PageTypeEnum = z.enum(['page', 'folder']);
+ export const PageTypeEnum = z.enum(['page']);
```

Or deprecate the field and always default to `'page'`.

### Phase 8: Update icon logic

Keep the current icon logic in `SidebarTreeView.tsx` — it already works correctly:

```typescript
// This is already correct — shows folder icon for ANY page with children
{hasChildren
  ? (isExpanded ? <FolderOpen .../> : <Folder .../>)
  : <FileText .../>
}
```

Remove the `isFolder` check from the condition since we no longer need it:

```diff
- {(isFolder || hasChildren)
+ {hasChildren
```

### Phase 9: Tests

Update tests across:
- `SidebarTreeView.test.tsx` — remove folder-specific click behavior tests
- `pages-crud.test.ts` — remove folder body rejection tests, add test that empty pages can have content added
- `PageViewPage.test.tsx` — update folder view tests to empty-page view tests
- `LocationPicker.test.tsx` — no changes (already uses `hasChildren`)

## Acceptance Criteria

- [ ] "New Folder" creates a regular empty page (no `pageType: 'folder'`)
- [ ] Clicking any item in sidebar navigates to it (no toggle-only behavior)
- [ ] Pages with children show folder icons (existing behavior preserved)
- [ ] Empty pages show "no content" message with edit button
- [ ] Previously-folder pages can now have content added
- [ ] Existing folder pages are migrated to regular pages
- [ ] All existing hierarchy features work (move, reorder, breadcrumb, tree)
- [ ] Confluence pages with sub-pages continue to work unchanged
- [ ] All tests updated and passing
