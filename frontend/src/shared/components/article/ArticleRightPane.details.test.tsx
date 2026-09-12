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

function renderDetails(overrides: Partial<typeof pageFixture> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    let data: unknown;
    if (url.pathname.endsWith('/comments')) data = [noteFixture];
    else if (url.pathname === '/api/pages/pinned') data = { items: [] };
    else if (/^\/api\/pages\/\d+$/.test(url.pathname)) {
      data = { ...pageFixture, ...overrides, id: url.pathname.split('/').at(-1) };
    } else if (url.pathname === '/api/settings') {
      data = { confluenceUrl: 'https://confluence.example.com' };
    } else if (url.pathname === '/api/permissions/check') data = { allowed: true };
    else if (url.pathname === '/api/llm/usecase-default') data = { model: null };
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
  window.innerWidth = 1280;
  useUiStore.setState({ articleSidebarCollapsed: false, articleSidebarLaptopExpanded: true, articleSidebarWidth: 400 });
  useArticleViewStore.setState({ headings: [], editing: false });
  useAiDockStore.setState({ open: false });
});

afterEach(cleanup);

describe('Details trust and draft continuity', () => {
  it('does not certify failed indexing when the error text is absent and a human verification exists', async () => {
    renderDetails({ embeddingStatus: 'failed', verifiedAt: '2026-09-02T12:00:00Z' });
    await waitFor(() => expect(screen.getByText('Search indexing failed')).toBeVisible());
    expect(screen.getByTestId('embedding-status-badge')).toHaveTextContent('Embedding Failed');
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
