import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleRightPane } from './ArticleRightPane';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useUiStore } from '../../../stores/ui-store';

const mockNavigate = vi.fn();
const mockDeletePage = vi.fn();
const mockPinPage = vi.fn();
const mockUnpinPage = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockPage = {
  id: 'page-1',
  title: 'Engineering Handbook',
  spaceKey: 'ENG',
  bodyHtml: '<h1>Intro</h1>',
  bodyText: 'Body',
  version: 7,
  parentId: null,
  labels: ['docs'],
  author: 'simon',
  lastModifiedAt: '2026-03-01T12:00:00Z',
  lastSynced: '2026-03-01T12:00:00Z',
  hasChildren: false,
  embeddingDirty: false,
  embeddingStatus: 'embedded',
  embeddedAt: '2026-03-01T12:00:00Z',
  embeddingError: null,
};

vi.mock('../hooks/use-pages', () => ({
  usePage: () => ({ data: mockPage, isLoading: false }),
  useDeletePage: () => ({ mutateAsync: mockDeletePage }),
  usePinnedPages: () => ({ data: { items: [] }, isLoading: false }),
  usePinPage: () => ({ mutate: mockPinPage }),
  useUnpinPage: () => ({ mutate: mockUnpinPage }),
}));

vi.mock('../hooks/use-settings', () => ({
  useSettings: () => ({
    data: { confluenceUrl: 'https://confluence.example.com' },
  }),
}));

vi.mock('./FreshnessBadge', () => ({
  FreshnessBadge: ({ lastModified }: { lastModified: string }) => <span>{lastModified}</span>,
}));

vi.mock('./EmbeddingStatusBadge', () => ({
  EmbeddingStatusBadge: ({ embeddingStatus }: { embeddingStatus: string }) => (
    <span data-testid="embedding-status-badge">{embeddingStatus}</span>
  ),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <LazyMotion features={domMax}>
            <Routes>
              <Route path="/pages/:id" element={children} />
            </Routes>
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('ArticleRightPane', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockDeletePage.mockReset().mockResolvedValue(undefined);
    mockPinPage.mockReset();
    mockUnpinPage.mockReset();
    localStorage.clear();
    useUiStore.setState({ articleSidebarCollapsed: false, articleSidebarWidth: 280 });
    useArticleViewStore.setState({ headings: [], editing: false });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the expanded pane with header and action buttons', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
    expect(screen.getByText('Properties')).toBeInTheDocument();
    expect(screen.getByText('AI Improve')).toBeInTheDocument();
    expect(screen.getByText('Pin')).toBeInTheDocument();
    expect(screen.getByText('Open in Confluence')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('collapses to a slim rail when the collapse button is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByLabelText('Collapse article sidebar'));

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('expands from the rail when the expand button is clicked', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand article sidebar'));

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
  });

  it('hides action buttons when editing is active', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByTestId('article-actions')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Improve')).not.toBeInTheDocument();
  });

  it('navigates to AI Improve when the button is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('AI Improve'));

    expect(mockNavigate).toHaveBeenCalledWith('/ai?mode=improve&pageId=page-1');
  });

  it('renders outline headings from the article-view-store', () => {
    useArticleViewStore.setState({
      headings: [
        { id: 'intro', text: 'Introduction', level: 1 },
        { id: 'usage', text: 'Usage', level: 2 },
      ],
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Introduction')).toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
    expect(screen.getByText('2 sections')).toBeInTheDocument();
  });

  it('shows empty message when there are no headings', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('No headings in this article.')).toBeInTheDocument();
  });

  it('renders version and space key in the footer', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText(/v7/)).toBeInTheDocument();
    expect(screen.getByText(/ENG/)).toBeInTheDocument();
  });

  it('has a resize handle', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByRole('separator', { name: 'Resize article sidebar' })).toBeInTheDocument();
  });
});
