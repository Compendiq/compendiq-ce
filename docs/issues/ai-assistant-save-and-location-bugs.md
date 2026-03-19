# Issue: AI Assistant generate mode — cannot save to Confluence & wrong location dropdown

## Bug Description

When using the AI Assistant in **Generate mode** to create a documentation article, three bugs occur:

1. **Save to Confluence silently fails** — the page is created as a standalone article with no space instead of being published to Confluence
2. **No local/standalone save support** — the UI only shows "Save to Confluence" with no option to save locally
3. **Wrong folder/location in the dropdown** — the parent page picker shows incorrect results compared to the working New Page form

The **New Page form** (`NewPagePage.tsx`) works correctly for the same operations.

## Root Cause Analysis

### Bug 1 (CRITICAL): Save to Confluence fails — missing `source` field

The `GenerateSavePanel` (line 331-357 of `GenerateMode.tsx`) sends this payload to `POST /api/pages`:

```typescript
// GenerateSavePanel sends:
{
  spaceKey: 'ENG',          // ← Confluence space key
  title: 'My Article',
  bodyHtml: '<p>content</p>',
  parentId: '123',          // optional
  // source: ???             // ← NOT SENT!
}
```

The `CreatePageSchema` in `packages/contracts/src/schemas/pages.ts:71` defaults `source` to `'standalone'`:

```typescript
source: PageSourceEnum.optional().default('standalone'),  // defaults to 'standalone'!
```

The backend (`pages-crud.ts:545`) then checks:

```typescript
const isStandalone = body.source === 'standalone' || !body.spaceKey;
//                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                   TRUE! because source defaulted to 'standalone'
```

**This routes to the standalone branch (line 547-609) instead of the Confluence branch (line 611-647).** In the standalone branch, it validates the space key against local spaces only:

```typescript
// pages-crud.ts:556-564 — standalone branch
if (body.spaceKey) {
  const spaceCheck = await query<{ source: string }>(
    'SELECT source FROM spaces WHERE space_key = $1',
    [body.spaceKey],
  );
  if (spaceCheck.rows.length > 0 && spaceCheck.rows[0].source === 'local') {
    spaceKey = body.spaceKey;  // Only accepts LOCAL spaces!
  }
  // If Confluence space → spaceKey stays null!
}
```

**Result**: The page is created as a standalone article with `space_key = NULL`, `source = 'standalone'`. The user thinks it saved to Confluence but it's actually an orphaned local page with no space. The Confluence API is never called.

**NewPagePage doesn't have this bug** because when `articleType === 'confluence'`, the backend receives a valid Confluence space key and `source` defaults to `'standalone'`, BUT NewPagePage only enters the Confluence path through a different flow where the client sends `source: 'confluence'` explicitly... Actually, looking more closely, **NewPagePage also doesn't send `source` explicitly**. The difference is that NewPagePage uses `spaceKey: '__local__'` for local articles, so it goes through the standalone path correctly. For Confluence articles, it sends a real space key — which means **NewPagePage has the same latent bug for Confluence saves**, but it may not be triggered if the Confluence create flow has a different entry point.

**Wait — re-examining**: NewPagePage line 62-67:
```typescript
const result = await createMutation.mutateAsync({
  spaceKey: articleType === 'confluence' ? spaceKey : '__local__',
  title: title.trim(),
  bodyHtml,
  ...(parentId ? { parentId } : {}),
  ...(articleType === 'local' ? { visibility } : {}),
});
```

NewPagePage also doesn't send `source: 'confluence'`. So both flows hit the standalone branch. But NewPagePage works because when users test with local articles, `spaceKey = '__local__'` routes correctly. **For Confluence articles from NewPagePage, the same bug exists** — the Confluence API is never called, the page is saved locally only.

**UPDATE**: After further analysis, this is actually a **design issue in the backend routing logic**. The `isStandalone` check at line 545 should be:

```typescript
// Current (broken for both NewPagePage and GenerateSavePanel):
const isStandalone = body.source === 'standalone' || !body.spaceKey;

// Should check if the space is actually a Confluence space:
const spaceRow = body.spaceKey
  ? (await query('SELECT source FROM spaces WHERE space_key = $1', [body.spaceKey])).rows[0]
  : null;
const isStandalone = !spaceRow || spaceRow.source === 'local';
```

Or alternatively, the frontend should explicitly send `source: 'confluence'` when saving to Confluence.

### Bug 2: No local page support in GenerateSavePanel

The `GenerateSavePanel` component (line 316-426 of `GenerateMode.tsx`) is **hardcoded to only show Confluence spaces**:

- The space dropdown (`useSpaces()`) only shows Confluence-synced spaces — **no local spaces**
- There is no article type toggle (local vs Confluence) unlike `NewPagePage`
- The save handler always sends to a Confluence space, which fails if the user doesn't have Confluence configured
- The toast says `"Page created in Confluence"` even though the page is actually saved as standalone

**Comparison with NewPagePage** (working):
```
NewPagePage:
  ├── Article type toggle: local | confluence
  ├── For local: spaceKey = '__local__', visibility selector
  ├── For confluence: space selector from useSpaces()
  └── Both: LocationPicker with tree view

GenerateSavePanel (broken):
  ├── No article type toggle
  ├── Space selector from useSpaces() only (no local spaces)
  ├── No source field sent → backend defaults to standalone
  └── ParentPagePicker (flat search, wrong results)
```

### Bug 2: Wrong folder in location dropdown — uses wrong component

The AI Assistant uses a **simplified `ParentPagePicker`** (lines 42-165) instead of the proper **`LocationPicker`** component used by `NewPagePage`:

| Feature | `LocationPicker` (NewPagePage) | `ParentPagePicker` (AI Assistant) |
|---------|-------------------------------|-----------------------------------|
| Data source | `usePageTree()` — full hierarchy | `usePages()` — flat search results |
| Display | Hierarchical tree with expand/collapse | Flat list of search results |
| Breadcrumbs | Yes — shows `Space > Parent > Child` | No — just page title |
| Folder icons | Yes — distinguishes folders from pages | No — all items look the same |
| Root level | Explicit "Root level" with confirm | "None (root level)" |
| Search behavior | Filters tree, auto-expands matches | Flat API search, may return wrong pages |
| Space awareness | Tree scoped to selected space | Queries with spaceKey filter, but results may leak |

**The `ParentPagePicker` shows wrong pages because:**
1. It calls `usePages({ spaceKey, search, limit: 20 })` which returns a **flat search** across the space
2. No hierarchy information — user can't tell where pages are in the tree
3. When `spaceKey` changes, the search results may briefly show stale data from the previous space
4. The `selectedPage` lookup (line 64) searches the current page of results — if the previously selected parent isn't in the current 20-result window, it shows "None (root level)" even though a parent IS selected

## Affected Files

### Backend (Confluence save routing bug)
- `backend/src/routes/knowledge/pages-crud.ts` — `POST /api/pages` standalone vs Confluence routing (line 545)
- `packages/contracts/src/schemas/pages.ts` — `CreatePageSchema` default for `source` (line 71)

### Frontend (save panel + location picker bugs)
- `frontend/src/features/ai/modes/GenerateMode.tsx` — `GenerateSavePanel` and `ParentPagePicker`

### Frontend (working reference)
- `frontend/src/features/pages/NewPagePage.tsx` — correct implementation to follow
- `frontend/src/shared/components/LocationPicker.tsx` — proper tree-based picker

### Tests
- `frontend/src/features/ai/modes/GenerateMode.test.tsx` — needs updates
- `backend/src/routes/knowledge/pages-crud.test.ts` — needs test for `source: 'confluence'`

## Implementation Plan

### Phase 1: Fix backend Confluence routing (CRITICAL)

The backend `POST /api/pages` handler at `pages-crud.ts:545` uses `body.source` to decide the code path, but `source` defaults to `'standalone'`. Two options:

**Option A (recommended)** — Frontend sends `source: 'confluence'` explicitly:

In `GenerateSavePanel` and `NewPagePage`, when saving to a Confluence space:
```typescript
const result = await createPage.mutateAsync({
  spaceKey,
  title: title.trim(),
  bodyHtml,
  source: 'confluence',          // ← MUST send this for Confluence save
  ...(parentId ? { parentId } : {}),
});
```

**Option B** — Backend auto-detects from space type:
```typescript
// pages-crud.ts:545 — replace the routing check
const spaceRow = body.spaceKey
  ? (await query<{ source: string }>(
      'SELECT source FROM spaces WHERE space_key = $1', [body.spaceKey]
    )).rows[0]
  : null;
const isStandalone = !spaceRow || spaceRow.source !== 'confluence';
```

Option A is simpler and more explicit. Option B is more robust but adds a DB query to every create.

### Phase 2: Fix GenerateSavePanel to send `source: 'confluence'`

Update the save handler in `GenerateMode.tsx`:

```diff
  const bodyHtml = markdownToHtml(generatedContent);
  const result = await createPage.mutateAsync({
    spaceKey,
    title: title.trim(),
    bodyHtml,
+   source: 'confluence',
    ...(parentId ? { parentId } : {}),
  });
```

Also fix `NewPagePage.tsx` which has the same latent bug:
```diff
  const result = await createMutation.mutateAsync({
    spaceKey: articleType === 'confluence' ? spaceKey : '__local__',
    title: title.trim(),
    bodyHtml,
+   ...(articleType === 'confluence' ? { source: 'confluence' } : {}),
    ...(parentId ? { parentId } : {}),
    ...(articleType === 'local' ? { visibility } : {}),
  });
```

### Phase 3: Replace `ParentPagePicker` with `LocationPicker`

Remove the custom `ParentPagePicker` component (lines 42-165) and import the shared `LocationPicker`:

```diff
- import { usePages, useCreatePage, type PageFilters } from '../../../shared/hooks/use-pages';
+ import { useCreatePage } from '../../../shared/hooks/use-pages';
+ import { LocationPicker } from '../../../shared/components/LocationPicker';
+ import type { LocationSelection } from '../../../shared/components/LocationPicker';
```

Replace in the save panel form:
```diff
- <ParentPagePicker
-   spaceKey={spaceKey}
-   parentId={parentId}
-   onSelect={(id) => setParentId(id)}
- />
+ {spaceKey && (
+   <LocationPicker
+     spaceKey={spaceKey}
+     parentId={parentId ?? undefined}
+     onSelect={(selection) => setParentId(selection.parentId ?? null)}
+   />
+ )}
```

### Phase 4: Add local page support with article type toggle

Add article type state and visibility to `GenerateSavePanel`:

```typescript
const [articleType, setArticleType] = useState<'local' | 'confluence'>('local');
const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
```

Update the save handler to branch on article type:
```typescript
const result = await createPage.mutateAsync({
  spaceKey: articleType === 'confluence' ? spaceKey : '__local__',
  title: title.trim(),
  bodyHtml,
  ...(articleType === 'confluence' ? { source: 'confluence' } : {}),
  ...(parentId ? { parentId } : {}),
  ...(articleType === 'local' ? { visibility } : {}),
});
```

Add a type toggle UI matching `NewPagePage`'s pattern (Local / Confluence buttons).

### Phase 5: Fix space selector to conditionally show

- For `confluence` type: show space dropdown from `useSpaces()` + send `source: 'confluence'`
- For `local` type: show visibility picker instead, set spaceKey to `'__local__'`
- Reset `parentId` when article type changes

### Phase 6: Update save button text and toast

```diff
- Save to Confluence
+ Save as Page
```

And the success toast — use the returned `source` to differentiate:
```diff
- toast.success(`Page "${result.title}" created in Confluence`);
+ const target = result.source === 'confluence' ? ' in Confluence' : '';
+ toast.success(`Page "${result.title}" created${target}`);
```

### Phase 7: Update tests

**Frontend** — Update `GenerateMode.test.tsx`:
- Test that save payload includes `source: 'confluence'` when saving to Confluence
- Test that `LocationPicker` is rendered instead of `ParentPagePicker`
- Test article type toggle (local vs confluence)
- Test save with local space (`__local__`)
- Test save with Confluence space
- Test parent reset when article type changes
- Test parent reset when space changes
- Test visibility selector for local articles

**Backend** — Update `pages-crud.test.ts`:
- Test that `POST /api/pages` with `source: 'confluence'` and a Confluence space key triggers Confluence API
- Test that `POST /api/pages` without `source` and a Confluence space key defaults to standalone (current behavior, now documented)

**Frontend** — Update `NewPagePage.test.tsx`:
- Test that Confluence save sends `source: 'confluence'`

### Phase 8: Delete dead code

Remove the `ParentPagePicker` component (lines 42-165) from `GenerateMode.tsx` — it's internal to this file and not imported anywhere else.

## Acceptance Criteria

- [ ] **Confluence save works** — AI Assistant save to Confluence actually calls the Confluence API and publishes the page
- [ ] `source: 'confluence'` is sent in the create payload when saving to a Confluence space
- [ ] NewPagePage also sends `source: 'confluence'` (same latent bug fixed)
- [ ] AI Assistant generate mode can save pages as local (standalone) articles
- [ ] Location dropdown uses the shared `LocationPicker` with proper tree hierarchy
- [ ] Location dropdown shows correct pages for the selected space
- [ ] Switching spaces resets the parent page selection
- [ ] Switching article type resets the parent page selection
- [ ] Local articles show visibility toggle (private/shared)
- [ ] Save button and toast text are context-appropriate
- [ ] All existing tests pass (GenerateMode, NewPagePage, pages-crud)
- [ ] New tests cover Confluence source field, local save, type toggle, and LocationPicker integration
- [ ] `ParentPagePicker` dead code is removed
