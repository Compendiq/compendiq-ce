import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';
import { useArticleViewStore } from '../../stores/article-view-store';

const mockNavigate = vi.fn();
const mockUpdatePage = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../shared/components/ArticleViewer', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  return {
    ArticleViewer: ({
      className,
      content,
      onHeadingsReady,
      onImageClick,
    }: {
      className?: string;
      content: string;
      onHeadingsReady?: (headings: Array<{ id: string; text: string; level: number }>) => void;
      onImageClick?: (src: string, alt: string) => void;
    }) => {
      React.useEffect(() => {
        onHeadingsReady?.([
          { id: 'intro', text: 'Introduction', level: 1 },
          { id: 'usage', text: 'Usage', level: 2 },
        ]);
      }, [onHeadingsReady]);

      return (
        <div className={className}>
          <button onClick={() => onImageClick?.('/api/attachments/page-1/diagram.png', 'Diagram')}>
            Preview image
          </button>
          <div dangerouslySetInnerHTML={{ __html: content }} />
        </div>
      );
    },
  };
});

vi.mock('../../shared/components/Editor', () => ({
  Editor: ({
    content,
    onChange,
  }: {
    content: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Article editor"
      value={content}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  getDraft: () => null,
  clearDraft: vi.fn(),
}));

vi.mock('../../shared/components/FeatureErrorBoundary', () => ({
  FeatureErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../shared/components/FreshnessBadge', () => ({
  FreshnessBadge: ({ lastModified }: { lastModified: string }) => <span>{lastModified}</span>,
}));

vi.mock('../../shared/components/EmbeddingStatusBadge', () => ({
  EmbeddingStatusBadge: ({ embeddingStatus }: { embeddingStatus: string }) => (
    <span data-testid="embedding-status-badge">{embeddingStatus}</span>
  ),
}));

vi.mock('../../shared/components/Skeleton', () => ({
  PageViewSkeleton: () => <div data-testid="page-view-skeleton" />,
}));

vi.mock('../../shared/hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: (src: string) => ({ blobSrc: src, loading: false }),
}));

const mockPage = {
  id: 'page-1',
  title: 'Engineering Handbook',
  spaceKey: 'ENG',
  bodyHtml: '<h1 id="intro">Introduction</h1><p>Body</p>',
  bodyText: 'Body',
  version: 7,
  parentId: null,
  labels: ['docs', 'platform'],
  author: 'simon',
  lastModifiedAt: '2026-03-01T12:00:00Z',
  lastSynced: '2026-03-01T12:00:00Z',
  hasChildren: true,
  embeddingDirty: false,
  embeddingStatus: 'embedded',
  embeddedAt: '2026-03-01T12:00:00Z',
  embeddingError: null,
};

let currentMockPage: typeof mockPage | undefined = mockPage;
let mockIsLoading = false;

vi.mock('../../shared/hooks/use-pages', () => ({
  usePage: () => ({ data: mockIsLoading ? undefined : currentMockPage, isLoading: mockIsLoading }),
  useUpdatePage: () => ({ mutateAsync: mockUpdatePage, isPending: false }),
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

describe('PageViewPage', () => {
  beforeEach(() => {
    currentMockPage = mockPage;
    mockIsLoading = false;
    mockNavigate.mockReset();
    mockUpdatePage.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();

    useAuthStore.getState().setAuth('token', {
      id: '1',
      username: 'simon',
      role: 'user',
    });
  });

  afterEach(() => {
    useAuthStore.getState().clearAuth();
    useArticleViewStore.getState().setHeadings([]);
    useArticleViewStore.getState().setEditing(false);
    document.body.innerHTML = '';
  });

  it('renders the article title and space key in the breadcrumb', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Engineering Handbook')).toBeInTheDocument();
    expect(screen.getByText('ENG')).toBeInTheDocument();
  });

  it('renders the Edit button in the header (action buttons moved to right pane)', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Edit')).toBeInTheDocument();
    // AI Improve, Pin, Confluence, Delete are now in ArticleRightPane
    expect(screen.queryByText('AI Improve')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('resets the app scroll container when the article route renders', async () => {
    const scrollContainer = document.createElement('div');
    scrollContainer.setAttribute('data-scroll-container', '');
    document.body.appendChild(scrollContainer);

    const scrollSpy = vi.spyOn(scrollContainer, 'scrollTo');

    render(<PageViewPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    });
  });

  it('opens the lightbox from article media', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Preview image'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close preview'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows save and cancel buttons in edit mode', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Edit'));

    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('saves edited article content', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByDisplayValue('Engineering Handbook'), {
      target: { value: 'Updated Engineering Handbook' },
    });
    fireEvent.change(screen.getByLabelText('Article editor'), {
      target: { value: '<p>Updated content</p>' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockUpdatePage).toHaveBeenCalledWith({
        id: 'page-1',
        title: 'Updated Engineering Handbook',
        bodyHtml: '<p>Updated content</p>',
        version: 7,
      });
    });
  });

  it('syncs headings to article-view-store for the right pane', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      const storeHeadings = useArticleViewStore.getState().headings;
      expect(storeHeadings).toHaveLength(2);
      expect(storeHeadings[0].text).toBe('Introduction');
    });
  });

  it('syncs editing state to article-view-store', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(useArticleViewStore.getState().editing).toBe(false);

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => {
      expect(useArticleViewStore.getState().editing).toBe(true);
    });
  });
});
