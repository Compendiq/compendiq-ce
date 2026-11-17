import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { ArticleRightPane } from './ArticleRightPane';
import { useUiStore } from '../../../stores/ui-store';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import type { EmbeddingStatus, QualityStatus } from '../../hooks/use-pages';

const pageFixture = {
  id: '1',
  confluenceId: '98765432',
  title: 'Engineering handbook',
  spaceKey: 'ENG',
  source: 'confluence',
  pageType: 'page',
  visibility: 'shared',
  version: 7,
  parentId: null,
  labels: ['engineering'],
  author: 'A reviewer',
  bodyHtml: '<h2>Introduction</h2>',
  bodyText: 'Introduction',
  hasChildren: false,
  lastModifiedAt: '2026-09-01T12:00:00Z',
  lastSynced: '2026-09-01T12:00:00Z',
  embeddingDirty: false,
  embeddingStatus: 'embedded' as EmbeddingStatus,
  embeddedAt: '2026-09-01T12:00:00Z',
  embeddingError: null,
  qualityScore: 85,
  qualityStatus: 'analyzed' as QualityStatus,
  qualityError: null,
  verifiedAt: null as string | null,
};

const noteFixture = {
  id: 'note-1',
  parentId: null,
  authorName: 'Another reviewer',
  body: 'Check the example before publishing.',
  createdAt: '2026-09-01T12:00:00Z',
  resolved: false,
};

let autoTagModel: string | null = null;

const versionsFixture = {
  pageId: '1',
  versions: [
    { versionNumber: 2, title: 'Engineering handbook', editedAt: '2026-09-01T12:00:00Z', syncedAt: null, author: null, message: null, isCurrent: true },
    { versionNumber: 1, title: 'Engineering handbook', editedAt: '2026-08-01T12:00:00Z', syncedAt: null, author: null, message: null, isCurrent: false },
  ],
};

function renderDetails(overrides: Partial<typeof pageFixture> & { isFrozen?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    let data: unknown;
    if (url.pathname.endsWith('/comments')) data = [noteFixture];
    else if (url.pathname === '/api/pages/pinned') data = { items: [] };
    else if (url.pathname === '/api/pages/1/versions') data = versionsFixture;
    else if (/^\/api\/pages\/\d+$/.test(url.pathname)) {
      data = { ...pageFixture, ...overrides, id: url.pathname.split('/').at(-1) };
    } else if (url.pathname === '/api/settings') {
      data = { confluenceUrl: 'https://confluence.example.com' };
    } else if (url.pathname === '/api/permissions/check') data = { allowed: true };
    else if (url.pathname === '/api/llm/usecase-default') data = { model: autoTagModel };
    else if (url.pathname === '/api/spaces' || url.pathname === '/api/spaces/local') data = [];
    else return new Response(JSON.stringify({ error: `Unexpected request: ${url.pathname}` }), { status: 404 });
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const router = createMemoryRouter(
    [{ path: '/pages/:id', element: <ArticleRightPane /> }],
    { initialEntries: ['/pages/1'] },
  );
  render(
    <QueryClientProvider client={client}>
      <LazyMotion features={domAnimation}>
        <RouterProvider router={router} />
      </LazyMotion>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  autoTagModel = null;
  window.innerWidth = 1280;
  useUiStore.setState({ articleSidebarCollapsed: false, articleSidebarLaptopExpanded: true, articleSidebarWidth: 400 });
  useArticleViewStore.setState({ headings: [], editing: false });
  useAiDockStore.setState({ open: false });
});

afterEach(cleanup);

describe('Details trust and draft continuity', () => {
  it('cancels deferred notes scrolling when the inspector unmounts', async () => {
    renderDetails();
    await screen.findByText(noteFixture.body);
    const scroll = vi.fn();
    const section = screen.getByTestId('details-notes-section');
    section.scrollIntoView = scroll;
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, { key: 'n', altKey: true });
      cleanup();
      // Keep an unrelated successor element with the same ID in the document:
      // a stale callback must not navigate the newly mounted article either.
      const successor = document.createElement('div');
      successor.id = 'details-notes-section';
      successor.scrollIntoView = scroll;
      document.body.appendChild(successor);
      try {
        act(() => { vi.advanceTimersByTime(100); });
        expect(scroll).not.toHaveBeenCalled();
      } finally {
        successor.remove();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not certify failed indexing when the error text is absent and a human verification exists', async () => {
    renderDetails({ embeddingStatus: 'failed', verifiedAt: '2026-09-02T12:00:00Z' });
    await waitFor(() => expect(screen.getByText('Search indexing failed')).toBeVisible());
    expect(screen.getByTestId('embedding-status-badge')).toHaveTextContent('Indexing failed');
    expect(screen.queryByText(/Indexed for AI search|Verified and ready for AI search/)).not.toBeInTheDocument();
  });

  it('names quality analysis separately from indexing that already completed', async () => {
    renderDetails({ qualityStatus: 'analyzing' });
    await waitFor(() => expect(screen.getByText('Quality analysis in progress')).toBeVisible());
    expect(screen.getByTestId('embedding-status-badge')).toHaveAttribute('data-status', 'embedded');
    expect(screen.queryByText('Indexing in progress')).not.toBeInTheDocument();
  });

  it('retains note and reply drafts across tabs, honors Cancel, and isolates the next page', async () => {
    const router = renderDetails();
    await waitFor(() => expect(screen.getByText(noteFixture.body)).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'New note' }));
    const noteInput = screen.getByTestId('comment-textarea');
    fireEvent.change(noteInput, { target: { value: 'Unsent page note' } });
    const thread = screen.getByTestId('comment-thread-note-1');
    fireEvent.click(within(thread).getByRole('button', { name: /Reply/ }));
    fireEvent.change(within(thread).getByTestId('comment-textarea'), { target: { value: 'Unsent reply' } });

    fireEvent.click(screen.getByTestId('page-context-tab-outline'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('page-context-tab-details'));
    expect(screen.getByDisplayValue('Unsent page note')).toBeVisible();
    await waitFor(() => expect(screen.getByDisplayValue('Unsent reply')).toBeVisible());

    fireEvent.click(within(thread).getByTestId('comment-cancel'));
    await waitFor(() => expect(within(thread).queryByTestId('comment-textarea')).not.toBeInTheDocument());
    fireEvent.click(within(thread).getByRole('button', { name: /Reply/ }));
    expect(within(thread).getByTestId('comment-textarea')).toHaveValue('');
    expect(noteInput).toHaveValue('Unsent page note');

    await act(async () => { await router.navigate('/pages/2'); });
    await waitFor(() => expect(screen.queryByDisplayValue('Unsent page note')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue('Unsent reply')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'New note' }));
    expect(screen.getByTestId('comment-textarea')).toHaveValue('');
  });
});

describe('protected writes on a frozen article (#277)', () => {
  const standalone = { source: 'standalone', confluenceId: null as unknown as string, spaceKey: 'LOCAL' };

  async function openActions() {
    const actions = await screen.findByTestId('article-actions');
    // Auto-tag waits on its model lookup; Pin is there from the first paint.
    await waitFor(() => expect(within(actions).getByRole('button', { name: /^Pin/ })).toBeInTheDocument());
    return actions;
  }

  async function restoreOffered() {
    fireEvent.click(within(screen.getByTestId('article-actions')).getByRole('button', { name: 'Version history' }));
    await screen.findByText('v1');
    return screen.queryByRole('button', { name: 'Restore version 1' }) !== null;
  }

  it('offers none of the writes the server refuses, and keeps reading and export', async () => {
    autoTagModel = 'tagger';
    renderDetails({ ...standalone, isFrozen: true });
    const actions = await openActions();
    // Give the auto-tag model lookup time to settle so its absence is a decision.
    await waitFor(() => expect(fetchCalls('/api/llm/usecase-default')).toBeGreaterThan(0));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(within(actions).queryByRole('button', { name: /Move to trash/ })).not.toBeInTheDocument();
    expect(within(actions).queryByRole('button', { name: /Auto-tag/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('relocate-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('danger-zone')).not.toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /Export PDF/ })).toBeInTheDocument();
    expect(within(actions).getByTestId('show-in-graph-btn')).toBeInTheDocument();

    // History stays readable; restoring an old version is a write.
    expect(await restoreOffered()).toBe(false);
  });

  it('still offers them on an editable article', async () => {
    autoTagModel = 'tagger';
    renderDetails({ ...standalone, isFrozen: false });
    const actions = await openActions();

    expect(await within(actions).findByRole('button', { name: /Auto-tag/ })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /Move to trash/ })).toBeInTheDocument();
    expect(await screen.findByTestId('relocate-btn')).toBeInTheDocument();
    expect(await restoreOffered()).toBe(true);
  });
});

function fetchCalls(pathname: string): number {
  return vi.mocked(globalThis.fetch).mock.calls
    .filter(([input]) => new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname === pathname)
    .length;
}
