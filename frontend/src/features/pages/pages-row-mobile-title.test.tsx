import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PagesPage } from './PagesPage';

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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
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
  ],
  total: 1,
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

/**
 * jsdom reports every rect as 0x0, which makes @tanstack/react-virtual render
 * zero rows and every assertion below silently pass against nothing. Same shim
 * as PagesPage.test.tsx.
 */
function installVirtualizerRectShim(): () => void {
  const originalGetBCR = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute?.('data-scroll-container')) {
      return { top: 0, left: 0, bottom: 800, right: 1024, width: 1024, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (this.hasAttribute?.('data-index')) {
      return { top: 0, left: 0, bottom: 80, right: 1024, width: 1024, height: 80, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return originalGetBCR.call(this);
  };
  return () => { Element.prototype.getBoundingClientRect = originalGetBCR; };
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
    const titleRow = title.parentElement as HTMLElement;
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
    const titleRow = title.parentElement as HTMLElement;
    // The badges land under the title only if they live in the SAME wrap
    // container. A refactor that moves them out (say, into the trailing
    // cluster) would strand them off-screen or hide them on mobile.
    const local = screen.getByTestId('badge-local');
    const shared = screen.getByTestId('badge-shared');
    expect(local.parentElement).toBe(titleRow);
    expect(shared.parentElement).toBe(titleRow);
    // shrink-0 stays: on a shared line the badges hold their width and the
    // title is the element that truncates — that contract is unchanged.
    expect(local.className).toContain('shrink-0');
    expect(shared.className).toContain('shrink-0');
  });

  it('wraps the pipeline badge below the title block instead of compressing it', async () => {
    render(<PagesPage />, { wrapper: createWrapper() });
    const title = await findTitle();
    const titleBlock = title.parentElement?.parentElement as HTMLElement;
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
