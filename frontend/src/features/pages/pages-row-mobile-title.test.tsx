import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PagesPage } from './PagesPage';
import { FIND_PLACEHOLDER } from './pages-find';
import { installVirtualizerRectShim } from '../../test-utils';

/**
 * A list row's title is the only thing that identifies it, and it was the only
 * thing in the row allowed to shrink: the source/visibility badges and the
 * pipeline badge are all `shrink-0`, so at 390px the metadata took its width
 * first and the title absorbed the entire deficit — "Incident runbook:
 * Postgres c…", "Quart…", "On-ca…"; four of six rows unidentifiable.
 *
 * The fix is structural and content-driven: below `sm` the row may WRAP — a
 * long title takes the full width and the badges drop beneath it, while a
 * short row keeps today's single line and never pays the extra height. At
 * `sm+` the added classes are inert and the single-line layout is untouched.
 *
 * jsdom performs no layout, so these tests assert the DOM contract the
 * classes encode — which elements share a wrap container, and which classes
 * allow the break — the same argument `article-measure-dom.test.tsx` makes
 * for the reading measure. They deliberately cannot see the built CSS: that
 * `max-sm:basis-auto` actually beats `flex-1`'s basis in cascade order is
 * only observable in a real browser against the compiled stylesheet.
 */

/** Title text lives in a span beside an optional PageIcon, inside the <p>. */
function titleLine(title: HTMLElement): HTMLElement {
  const line = title.closest('p');
  if (!line) throw new Error('expected the title to live inside a <p>');
  return line;
}

function createWrapper(initialEntries: string[] = ['/']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          {/* Scroll container PagesPage finds via [data-scroll-container] */}
          <div data-scroll-container style={{ height: 800, overflow: 'auto' }}>
            {children}
          </div>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

// One row wearing the full cluster from the finding: Local + Shared from
// source/visibility, "Not indexed" from embeddingDirty.
const pageTitle = 'Incident runbook: Postgres connection pool exhaustion';
const mockPagesResponse = {
  items: [
    {
      id: 'std-1',
      spaceKey: '__local__',
      title: pageTitle,
      version: 1,
      parentId: null,
      labels: ['runbook'],
      author: 'Alice',
      lastModifiedAt: '2025-01-15T00:00:00Z',
      lastSynced: '2025-01-16T00:00:00Z',
      embeddingDirty: true,
      embeddingStatus: 'pending',
      embeddedAt: null,
      source: 'standalone',
      visibility: 'shared',
    },
    {
      id: 'cf-1',
      spaceKey: 'OPS',
      title: 'Confluence page',
      version: 1,
      parentId: null,
      labels: [],
      author: 'Bob',
      lastModifiedAt: '2025-01-15T00:00:00Z',
      lastSynced: '2025-01-16T00:00:00Z',
      embeddingDirty: false,
      embeddingStatus: 'embedded',
      embeddedAt: '2025-01-16T00:00:00Z',
      source: 'confluence',
    },
    {
      id: 'std-2',
      spaceKey: '__local__',
      title: 'Private note',
      version: 1,
      parentId: null,
      labels: [],
      author: 'Alice',
      lastModifiedAt: '2025-01-15T00:00:00Z',
      lastSynced: '2025-01-16T00:00:00Z',
      embeddingDirty: false,
      embeddingStatus: 'embedded',
      embeddedAt: '2025-01-16T00:00:00Z',
      source: 'standalone',
      visibility: 'private',
    },
  ],
  total: 3,
  page: 1,
  limit: 50,
  totalPages: 1,
};

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/embeddings/status')) {
      return json({ totalPages: 1, embeddedPages: 0, dirtyPages: 1, totalEmbeddings: 0, isProcessing: false });
    }
    if (url.includes('/pages/filters')) return json({ authors: ['Alice'], labels: ['runbook'] });
    if (url.includes('/spaces')) return json([]);
    if (url.includes('/sync/status')) return json({ status: 'idle' });
    if (url.includes('/pages/pinned')) return json({ items: [], total: 0 });
    if (url.includes('/settings')) return json({});
    return json(mockPagesResponse);
  });
}

describe('PagesPage row: mobile title layout', () => {
  let restoreRects: () => void;

  beforeEach(() => {
    mockFetch();
    restoreRects = installVirtualizerRectShim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreRects();
  });

  async function findTitle(): Promise<HTMLElement> {
    return await screen.findByText(pageTitle);
  }

  it('lets the title row wrap below sm — content-driven, never forced', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await findTitle();
    const titleRow = titleLine(title).parentElement as HTMLElement;
    // The row must be ALLOWED to wrap below sm — without this the badges keep
    // their width and the shrinkable title absorbs the whole deficit — and
    // must NOT wrap at sm+, where the single-line layout is pinned.
    expect(titleRow.className).toContain('max-sm:flex-wrap');
    expect(titleRow.className).not.toMatch(/(?:^|\s)flex-wrap/);
    // The unprefixed `truncate` keeps the title to one ellipsised line at
    // every width; and no `max-sm:w-full` — a forced full-width title makes
    // every short row pay an extra line for zero gain (56.5px → 80px at
    // 390px, on the app's densest surface). The wrap engages only when the
    // title's content actually needs the width.
    expect(title.className).toContain('truncate');
    expect(title.className).not.toContain('max-sm:w-full');
  });

  it('keeps the source/visibility badges in the title row wrap container', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await findTitle();
    const titleRow = titleLine(title).parentElement as HTMLElement;
    // The badges land under the title only if they live in the SAME wrap
    // container. A refactor that moves them out (say, into the trailing
    // cluster) would strand them off-screen or hide them on mobile.
    const local = screen.getAllByTestId('badge-local')[0];
    const shared = screen.getAllByTestId('badge-shared')[0];
    expect(local.parentElement).toBe(titleRow);
    expect(shared.parentElement).toBe(titleRow);
    // shrink-0 stays: on a shared line the badges hold their width and the
    // title is the element that truncates — that contract is unchanged.
    expect(local.className).toContain('shrink-0');
    expect(shared.className).toContain('shrink-0');
  });

  it('hides idle Not indexed at rest so the list is titles, not pipeline noise', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    await findTitle();
    expect(screen.queryByTestId('page-state-badge')).not.toBeInTheDocument();
  });

  it('wraps the pipeline badge below the title block instead of compressing it', async () => {
    render(<PagesPage />, { wrapper: createWrapper(['/?embedding=pending']) });
    const title = await findTitle();
    const titleBlock = titleLine(title).parentElement?.parentElement as HTMLElement;
    const button = title.closest('button') as HTMLElement;
    // The pipeline badge ("Not indexed") is a sibling of the title block, so
    // the title-row wrap alone is not enough: the badge would still take its
    // width out of the flex-1 block. `basis-auto` makes the block's flex base
    // its content size — `flex-1`'s basis of 0 never triggers a line break —
    // so an overflowing block pushes the badge onto the next line, and a
    // short one keeps it beside (`basis-full` here would force every row
    // tall; content-driven is the point).
    expect(titleBlock.className).toContain('max-sm:basis-auto');
    expect(titleBlock.className).not.toContain('max-sm:basis-full');
    expect(button.className).toContain('max-sm:flex-wrap');
    expect(button.className).not.toMatch(/(?:^|\s)flex-wrap/);
    const stateBadge = screen.getByTestId('page-state-badge');
    expect(stateBadge).toHaveTextContent('Not indexed');
    // It stays OUTSIDE the title block (so it can wrap independently), and
    // inside the button — rendered at every width, as page-state.ts documents.
    expect(button.contains(stateBadge)).toBe(true);
    expect(titleBlock.contains(stateBadge)).toBe(false);
  });

  it('exposes the full title when the visible line truncates', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await findTitle();
    expect(title).toHaveAttribute('title', pageTitle);
  });

  it('keeps the select checkbox on the title line when the row grows', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await findTitle();
    const row = title.closest('[data-testid^="article-hover-"]') as HTMLElement;
    const checkbox = screen.getByTestId('page-select-std-1');
    // A centred checkbox on a wrapped (taller) row drifts down to the author/
    // date line. Top-aligned below sm — with a 2px nudge onto the title's
    // ~20px line — it stays beside the thing it selects. sm+ keeps
    // items-center: single-line rows centre exactly as before.
    expect(row.className).toContain('items-center');
    expect(row.className).toContain('max-sm:items-start');
    expect(checkbox.className).toContain('max-sm:mt-0.5');
  });

  it('does not grow the row button beyond its text content accessible name', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await findTitle();
    const button = title.closest('button') as HTMLElement;
    // The row button is named by its text content. The fix is classes only —
    // no aria-label, no extra text nodes — so the accessible name must not
    // have picked up a label that restates (or outranks) the visible text.
    expect(button).not.toHaveAttribute('aria-label');
    expect(button.textContent).toContain(pageTitle);
  });
});

/**
 * The semantic/hybrid search results on the SAME route are a SECOND row
 * renderer with the same anatomy — a `truncate` title beside a `shrink-0`
 * similarity chip — and the suite above cannot see it: it renders with search
 * off, so with semantic search on, titles still absorbed the whole deficit at
 * 390px while the browse list one toggle away wrapped.
 *
 * The mechanism is the browse row's, adapted to this row's structure. Two
 * adaptations matter, and both are pinned below:
 *
 * - the file icon is the FIRST flex item INSIDE the wrap container (the
 *   browse row's checkbox sits outside it), so the title block carries a
 *   max-width clamp of the icon's footprint — without it an overflowing
 *   block wraps wholesale below the icon instead of sending the chip down;
 * - the excerpt carries `contain:inline-size`, or ITS unwrapped length (not
 *   the title's) decides the block's content size and the wrap fires on
 *   virtually every row — forced in practice, which is exactly what the
 *   browse row's review rejected.
 */
describe('PagesPage search row: mobile title layout (semantic/hybrid)', () => {
  let restoreRects: () => void;

  // Distinct from the browse fixture's title so `findByText` can never match a
  // stale browse row from the pre-search render.
  const searchTitle = 'Postgres connection pool exhaustion: triage and recovery runbook';
  const searchExcerpt =
    'When the pool is exhausted, new connections queue behind long-running transactions and the API starts timing out.';

  /**
   * `/search`-aware fetch mock. `useSearch` fires two requests — keyword
   * (immediate) and semantic (enhanced) — and the real keyword branch never
   * emits `similarity`, so it is stripped from the keyword reply here exactly
   * as PagesPage.test.tsx's #1117 mock does: the chip these tests locate must
   * come from the enhanced leg, as in production.
   */
  function mockFetchWithSearch() {
    // `mapItems` in use-search.ts reads `snippet` into the row's excerpt.
    const item = {
      id: 'sr-1',
      title: searchTitle,
      spaceKey: 'DEV',
      snippet: searchExcerpt,
      rank: 0.0328,
      similarity: 0.74,
    };
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/search?')) {
        const mode = new URL(url, 'http://localhost').searchParams.get('mode') ?? 'keyword';
        const items =
          mode === 'keyword'
            ? [Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'similarity'))]
            : [item];
        return json({ items, total: 1, page: 1, limit: 10, totalPages: 1, mode, hasEmbeddings: true });
      }
      if (url.includes('/embeddings/status')) {
        return json({ totalPages: 1, embeddedPages: 1, dirtyPages: 0, totalEmbeddings: 1, isProcessing: false });
      }
      if (url.includes('/pages/filters')) return json({ authors: ['Alice'], labels: ['runbook'] });
      if (url.includes('/spaces')) return json([]);
      if (url.includes('/sync/status')) return json({ status: 'idle' });
      if (url.includes('/pages/pinned')) return json({ items: [], total: 0 });
      if (url.includes('/settings')) return json({});
      return json(mockPagesResponse);
    });
  }

  beforeEach(() => {
    mockFetchWithSearch();
    restoreRects = installVirtualizerRectShim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreRects();
  });

  /** Render, switch to semantic mode, type a query, and wait for the row. */
  async function renderSearchRow(): Promise<HTMLElement> {
    render(<PagesPage />, { wrapper: createWrapper() });
    // `useSemanticSearch = !!(search && searchMode !== 'keyword')` gates the
    // whole search-results section — keyword mode never renders this row.
    fireEvent.change(screen.getByPlaceholderText(FIND_PLACEHOLDER), {
      target: { value: 'postgres' },
    });
    fireEvent.click(screen.getByTestId('search-mode-semantic'));
    // useSearch debounces 300ms before fetching.
    return await screen.findByText(searchTitle, undefined, { timeout: 2000 });
  }

  it('lets the row wrap below sm — and keeps sm+ single-line', async () => {
    const title = await renderSearchRow();
    const button = title.closest('button') as HTMLElement;
    // Allowed to wrap below sm; pinned single-line at sm+, where every added
    // class is inert.
    expect(button.className).toContain('max-sm:flex-wrap');
    expect(button.className).not.toMatch(/(?:^|\s)flex-wrap/);
    // Content-driven, never forced: the title keeps its one ellipsised line,
    // and no `max-sm:w-full` forcing every short row to pay an extra line.
    expect(title.className).toContain('truncate');
    expect(title.className).not.toContain('max-sm:w-full');
  });

  it('clamps the title block beside the icon instead of wrapping below it', async () => {
    const title = await renderSearchRow();
    const titleBlock = titleLine(title).parentElement as HTMLElement;
    // `basis-auto` is what makes the wrap content-driven (`flex-1`'s basis of
    // 0 never triggers a line break) — and the clamp is what keeps the block
    // on the icon's line when it does engage: 100% minus the icon's 18px and
    // the 12px gap-3. Without it the overflowing block wraps below the icon,
    // stranding the glyph alone on its own line, with the chip on a third.
    expect(titleBlock.className).toContain('max-sm:basis-auto');
    expect(titleBlock.className).not.toContain('max-sm:basis-full');
    expect(titleBlock.className).toContain('max-sm:max-w-[calc(100%-30px)]');
  });

  it('keeps the similarity chip a shrink-0 sibling of the title block', async () => {
    const title = await renderSearchRow();
    const titleBlock = titleLine(title).parentElement as HTMLElement;
    const button = title.closest('button') as HTMLElement;
    const chip = screen.getByTitle('Semantic similarity to your query');
    // The chip wraps independently only as a SIBLING of the block, inside the
    // wrap container. Moving it into the block would put it under the excerpt
    // at every width; `shrink-0` stays so on a shared line the title is still
    // the element that gives way.
    expect(button.contains(chip)).toBe(true);
    expect(titleBlock.contains(chip)).toBe(false);
    expect(chip.className).toContain('shrink-0');
  });

  it('contains the excerpt so the title, not the excerpt, drives the wrap', async () => {
    const title = await renderSearchRow();
    const titleBlock = titleLine(title).parentElement as HTMLElement;
    const excerpt = screen.getByText(searchExcerpt);
    expect(titleBlock.contains(excerpt)).toBe(true);
    // Without inline-size containment the block's content size is the
    // excerpt's unwrapped length — nearly always wider than a phone row — so
    // the chip drops on virtually every row and the wrap is forced in
    // practice. Contained, the excerpt contributes zero intrinsic width and
    // still renders identically (fills the block, clamps at two lines).
    expect(excerpt.className).toContain('max-sm:[contain:inline-size]');
    expect(excerpt.className).toContain('line-clamp-2');
  });

  it('does not grow the row button beyond its text content accessible name', async () => {
    const title = await renderSearchRow();
    const button = title.closest('button') as HTMLElement;
    // Classes only — the accessible name must still be the visible text.
    expect(button).not.toHaveAttribute('aria-label');
    expect(button.textContent).toContain(searchTitle);
  });
});
