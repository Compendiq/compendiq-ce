import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';

const mockNavigate = vi.fn();
const mockUpdatePage = vi.fn();
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
  useDeletePage: () => ({ mutateAsync: mockDeletePage }),
  usePinnedPages: () => ({ data: { items: [] }, isLoading: false }),
  usePinPage: () => ({ mutate: mockPinPage }),
  useUnpinPage: () => ({ mutate: mockUnpinPage }),
}));

vi.mock('../../shared/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      confluenceUrl: 'https://confluence.example.com',
    },
  }),
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
    mockDeletePage.mockReset().mockResolvedValue(undefined);
    mockPinPage.mockReset();
    mockUnpinPage.mockReset();
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
    document.body.innerHTML = '';
  });

  it('renders a folder article with content metadata and labels', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Folder Article')).toBeInTheDocument();
    expect(screen.getByText('Engineering Handbook')).toBeInTheDocument();
    expect(screen.getByText('ENG')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('platform')).toBeInTheDocument();
    expect(screen.getByTestId('embedding-status-badge')).toHaveTextContent('embedded');
  });

  it('does not render the Library button', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.queryByText('Library')).not.toBeInTheDocument();
  });

  it('does not render the folder hierarchy info message', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(
      screen.queryByText(/This folder is also a readable article/),
    ).not.toBeInTheDocument();
  });

  it('renders the AI Improve button and navigates to the improve flow', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    const aiButton = screen.getByText('AI Improve');
    expect(aiButton).toBeInTheDocument();

    fireEvent.click(aiButton.closest('button')!);
    expect(mockNavigate).toHaveBeenCalledWith('/ai?mode=improve&pageId=page-1');
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

  it('collapses and reopens the outline rail', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('article-outline-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Hide outline'));
    expect(screen.getByTestId('article-outline-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show outline'));
    expect(await screen.findByTestId('article-outline-panel')).toBeInTheDocument();
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

  it('renders the collapse toggle button on the right side of the header', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByLabelText('Collapse article header')).toBeInTheDocument();
  });

  it('collapses the header when the toggle is clicked, hiding metadata and action buttons', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    expect(screen.getByText('AI Improve')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Collapse article header'));

    await waitFor(() => {
      expect(screen.queryByText('AI Improve')).not.toBeInTheDocument();
      expect(screen.queryByText('docs')).not.toBeInTheDocument();
    });

    expect(screen.getByLabelText('Expand article header')).toBeInTheDocument();
    // Title remains visible in the slim rail.
    expect(screen.getByText('Engineering Handbook')).toBeInTheDocument();
  });

  it('expands the header again when the toggle is clicked while collapsed', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByLabelText('Collapse article header'));
    await waitFor(() => expect(screen.queryByText('AI Improve')).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Expand article header'));
    expect(await screen.findByText('AI Improve')).toBeInTheDocument();
    expect(await screen.findByText('docs')).toBeInTheDocument();
  });

  it('persists collapsed state to localStorage', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByLabelText('Collapse article header'));

    await waitFor(() => {
      expect(localStorage.getItem('article-header-collapsed')).toBe('true');
    });

    fireEvent.click(screen.getByLabelText('Expand article header'));

    await waitFor(() => {
      expect(localStorage.getItem('article-header-collapsed')).toBe('false');
    });
  });

  it('restores collapsed state from localStorage on mount', async () => {
    localStorage.setItem('article-header-collapsed', 'true');

    render(<PageViewPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.queryByText('AI Improve')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Expand article header')).toBeInTheDocument();
  });

  it('keeps header expanded and hides the toggle while in edit mode', async () => {
    // Start collapsed.
    localStorage.setItem('article-header-collapsed', 'true');

    render(<PageViewPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.queryByText('AI Improve')).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Expand article header'));
    await waitFor(() => expect(screen.getByText('Edit')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    // In edit mode the toggle is hidden and the full header is visible.
    expect(screen.queryByLabelText('Collapse article header')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Expand article header')).not.toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
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
});
