# Issue: Pinned articles are not displayed anywhere in the UI

## Bug Description

Users can pin articles (via the toggle button in `ArticleRightPane`), but **pinned articles are never displayed anywhere in the UI**. The `PinnedArticlesSection` component is fully implemented and tested but is **not rendered in any page**.

## Root Cause Analysis

| Layer | Status | Details |
|-------|--------|---------|
| Database (`pinned_pages` table) | ✅ Complete | Migration 018 + FK migration 030 |
| Backend API (`/api/pages/pinned`, pin/unpin) | ✅ Complete | GET, POST, DELETE endpoints working |
| Frontend hooks (`usePinnedPages`, `usePinPage`, `useUnpinPage`) | ✅ Complete | With optimistic updates |
| Pin toggle in article sidebar (`ArticleRightPane`) | ✅ Complete | Users can pin/unpin from article detail |
| `PinnedArticlesSection` component | ✅ Complete | Glassmorphic cards, animations, unpin button |
| **Rendering `PinnedArticlesSection` in a page** | ❌ **Missing** | Component is orphaned — never imported |

### Why it happened

`DashboardPage` was deprecated and merged into `PagesPage` (issue #109). The `PinnedArticlesSection` was likely intended for the dashboard but was never wired into `PagesPage` when the merge happened. As a result:

- Users can pin articles (up to 8) via the article detail sidebar
- There is no way to see the list of pinned articles
- The only indicator is the "Pinned" button state when viewing an already-pinned article

## Affected Files

- `frontend/src/features/pages/PinnedArticlesSection.tsx` — orphaned component (never imported)
- `frontend/src/features/pages/PagesPage.tsx` — should render `PinnedArticlesSection`
- `frontend/src/features/dashboard/DashboardPage.tsx` — deprecated, returns `null`

## Implementation Plan

### 1. Integrate `PinnedArticlesSection` into `PagesPage`

- Import and render `PinnedArticlesSection` at the top of `PagesPage`, above the KPI cards and article list
- The component already returns `null` when there are no pins, so it won't affect users who haven't pinned anything
- Ensure it renders before the search/filter section for quick access

### 2. Add shared contract types (optional improvement)

- Move `PinnedPage` and `PinnedPagesResponse` types to `packages/contracts/src/schemas/pages.ts`
- Currently these types are defined inline in `frontend/src/shared/hooks/use-pages.ts`

### 3. Tests

- Add a test to `PagesPage.test.tsx` verifying `PinnedArticlesSection` is rendered
- Existing component tests (`PinnedArticlesSection.test.tsx`) already cover the component itself

## Acceptance Criteria

- [ ] Pinned articles section is visible on the Pages page when user has pinned articles
- [ ] Section is hidden when user has no pinned articles
- [ ] Users can unpin articles directly from the pinned section
- [ ] Clicking a pinned article navigates to the article detail view
- [ ] All existing pinned-pages tests continue to pass
- [ ] New integration test for PagesPage confirms section rendering
