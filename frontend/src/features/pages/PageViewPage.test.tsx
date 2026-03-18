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

vi.mock('../../shared/components/article/ArticleViewer', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  return {
    ArticleViewer: ({
      className,
      confluenceUrl,
      content,
      onHeadingsReady,
      onImageClick,
      pageId,
      confluencePageId,
    }: {
      className?: string;
      confluenceUrl?: string | null;
      content: string;
      onHeadingsReady?: (headings: Array<{ id: string; text: string; level: number }>) => void;
      onImageClick?: (src: string, alt: string) => void;
      pageId?: string | null;
      confluencePageId?: string | null;
    }) => {
      React.useEffect(() => {
        onHeadingsReady?.([
          { id: 'intro', text: 'Introduction', level: 1 },
          { id: 'usage', text: 'Usage', level: 2 },
        ]);
      }, [onHeadingsReady]);

      return (
        <div className={className} data-testid="article-viewer" data-confluence-url={confluenceUrl ?? ''} data-page-id={pageId ?? ''} data-confluence-page-id={confluencePageId ?? ''}>
          <button onClick={() => onImageClick?.('/api/attachments/page-1/diagram.png', 'Diagram')}>
            Preview image
          </button>
          <div dangerouslySetInnerHTML={{ __html: content }} />
        </div>
      );
    },
  };
});

vi.mock('../../shared/components/article/Editor', () => ({
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
  EditorToolbar: () => null,
  TableContextToolbar: () => null,
  getDraft: () => null,
  clearDraft: vi.fn(),
}));

vi.mock('../../shared/components/feedback/FeatureErrorBoundary', () => ({
  FeatureErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../shared/components/badges/QualityScoreBadge', () => ({
  QualityScoreBadge: () => <span data-testid="quality-score-badge" />,
}));

vi.mock('../../shared/components/article/ArticleSummary', () => ({
  ArticleSummary: () => <div data-testid="article-summary" />,
}));

vi.mock('../../shared/components/feedback/Skeleton', () => ({
  PageViewSkeleton: () => <div data-testid="page-view-skeleton" />,
}));

vi.mock('../../shared/components/TagEditor', () => ({
  TagEditor: () => <div data-testid="tag-editor" />,
}));

vi.mock('../../shared/components/diagrams/DrawioEditor', () => ({
  DrawioEditor: () => <div data-testid="drawio-editor" />,
}));

vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../shared/hooks/use-standalone', () => ({
  useSubmitFeedback: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVerifyPage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('../../shared/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock('../../shared/hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: (src: string) => ({ blobSrc: src, loading: false }),
}));

vi.mock('../../shared/hooks/use-settings', () => ({
  useSettings: () => ({
    data: { confluenceUrl: 'https://confluence.example.com' },
    isLoading: false,
  }),
}));

const mockPage = {
  id: 'page-1',
  confluenceId: '98765432',
  title: 'Engineering Handbook',
  spaceKey: 'ENG',
  pageType: 'page' as const,
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
  qualityScore: 85,
  qualityStatus: 'analyzed' as const,
  qualityCompleteness: 80,
  qualityClarity: 90,
  qualityStructure: 85,
  qualityAccuracy: 82,
  qualityReadability: 88,
  qualitySummary: 'Well-written article',
  qualityAnalyzedAt: '2026-03-01T12:00:00Z',
  qualityError: null,
  summaryHtml: null,
  summaryStatus: 'pending' as const,
  summaryGeneratedAt: null,
  summaryModel: null,
  summaryError: null,
};

let currentMockPage: typeof mockPage | undefined = mockPage;
let mockIsLoading = false;

vi.mock('../../shared/hooks/use-pages', () => ({
  usePage: () => ({ data: mockIsLoading ? undefined : currentMockPage, isLoading: mockIsLoading }),
  useUpdatePage: () => ({ mutateAsync: mockUpdatePage, isPending: false }),
  useUpdatePageLabels: () => ({ mutate: vi.fn(), isPending: false }),
  usePageFilterOptions: () => ({ data: { authors: [], labels: [] } }),
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

  it('passes confluenceUrl and confluencePageId to ArticleViewer for draw.io edit links', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    const viewer = screen.getByTestId('article-viewer');
    expect(viewer).toHaveAttribute('data-confluence-url', 'https://confluence.example.com');
    expect(viewer).toHaveAttribute('data-page-id', 'page-1');
    // confluencePageId should be the Confluence ID, not the internal page ID
    expect(viewer).toHaveAttribute('data-confluence-page-id', '98765432');
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
