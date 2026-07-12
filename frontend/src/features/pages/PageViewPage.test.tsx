import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, createMemoryRouter, RouterProvider } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageViewPage } from './PageViewPage';
import { useAuthStore } from '../../stores/auth-store';
import { useArticleViewStore } from '../../stores/article-view-store';
import { apiFetch } from '../../shared/lib/api';

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
      onEditDiagram,
      pageId,
      confluencePageId,
    }: {
      className?: string;
      confluenceUrl?: string | null;
      content: string;
      onHeadingsReady?: (headings: Array<{ id: string; text: string; level: number }>) => void;
      onImageClick?: (src: string, alt: string) => void;
      onEditDiagram?: (diagramName: string) => void;
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
          <button onClick={() => onEditDiagram?.('my-diagram')} data-testid="edit-diagram-trigger">
            Edit diagram
          </button>
          <div dangerouslySetInnerHTML={{ __html: content }} />
        </div>
      );
    },
  };
});

// Configurable draft content so tests can exercise the restore-draft dialog.
let mockDraftContent: string | null = null;

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
  getDraft: () => mockDraftContent,
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
  DrawioEditor: ({
    onSave,
  }: {
    onSave?: (dataUri: string, xml: string) => void;
  }) => (
    <div data-testid="drawio-editor">
      <button
        data-testid="drawio-save-trigger"
        onClick={() => onSave?.('data:image/png;base64,SAVED', '<mxGraphModel/>')}
      >
        Save diagram
      </button>
    </div>
  ),
}));

vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('./use-presence', () => ({
  usePresence: () => ({ viewers: [], selfIsEditing: false, setEditing: vi.fn() }),
}));

vi.mock('../../shared/hooks/use-standalone', () => ({
  useSubmitFeedback: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useVerifyPage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

let capturedShortcuts: Array<{ key: string; keys: string[]; mod?: boolean; alt?: boolean; shift?: boolean; description: string; category: string; action: () => void }> = [];
vi.mock('../../shared/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: (shortcuts: typeof capturedShortcuts) => {
    capturedShortcuts = shortcuts;
  },
}));

vi.mock('../../shared/hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: (src: string) => ({ blobSrc: src, loading: false }),
}));

vi.mock('../../shared/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      confluenceUrl: 'https://confluence.example.com',
      ollamaModel: 'qwen3.5',
      llmProvider: 'ollama',
      openaiModel: null,
    },
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
  source: 'confluence' as string,
  visibility: 'shared' as string,
  createdByUserId: null as string | number | null,
};

let currentMockPage: typeof mockPage | undefined = mockPage;
let mockIsLoading = false;

const mockPinMutate = vi.fn();
const mockUnpinMutate = vi.fn();
const mockDeleteMutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('../../shared/hooks/use-pages', () => ({
  usePage: () => ({ data: mockIsLoading ? undefined : currentMockPage, isLoading: mockIsLoading }),
  useUpdatePage: () => ({ mutateAsync: mockUpdatePage, isPending: false }),
  useUpdatePageLabels: () => ({ mutate: vi.fn(), isPending: false }),
  usePageFilterOptions: () => ({ data: { authors: [], labels: [] } }),
  usePinnedPages: () => ({ data: { items: [] } }),
  usePinPage: () => ({ mutate: mockPinMutate, isPending: false }),
  useUnpinPage: () => ({ mutate: mockUnpinMutate, isPending: false }),
  useDeletePage: () => ({ mutateAsync: mockDeleteMutateAsync, isPending: false }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/pages/page-1']}>
          <LazyMotion features={domAnimation}>
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
    capturedShortcuts = [];
    mockNavigate.mockReset();
    mockUpdatePage.mockReset().mockResolvedValue(undefined);
    mockPinMutate.mockReset();
    mockUnpinMutate.mockReset();
    mockDeleteMutateAsync.mockReset().mockResolvedValue(undefined);
    mockDraftContent = null;
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockResolvedValue({} as never);
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

  describe('feedback widget visibility', () => {
    it('hides "Was this page helpful?" on a standalone page created by the current user', () => {
      // Auth user id is '1' (set in beforeEach).
      currentMockPage = { ...mockPage, source: 'standalone', visibility: 'private', createdByUserId: '1' };
      render(<PageViewPage />, { wrapper: createWrapper() });

      expect(screen.queryByTestId('feedback-widget')).not.toBeInTheDocument();
      expect(screen.queryByText('Was this page helpful?')).not.toBeInTheDocument();
    });

    it('shows the widget on a standalone page created by another user', () => {
      currentMockPage = { ...mockPage, source: 'standalone', visibility: 'shared', createdByUserId: '2' };
      render(<PageViewPage />, { wrapper: createWrapper() });

      expect(screen.getByTestId('feedback-widget')).toBeInTheDocument();
      expect(screen.getByText('Was this page helpful?')).toBeInTheDocument();
    });

    it('shows the widget on Confluence-synced pages', () => {
      currentMockPage = { ...mockPage, source: 'confluence', createdByUserId: null };
      render(<PageViewPage />, { wrapper: createWrapper() });

      expect(screen.getByTestId('feedback-widget')).toBeInTheDocument();
    });
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

  it('shows error toast when draw.io attachment fetch returns non-OK status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: 'Not Found' }),
    );

    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('edit-diagram-trigger'));

    await waitFor(() => {
      // The draw.io editor should NOT be opened on fetch failure
      expect(screen.queryByTestId('drawio-editor')).not.toBeInTheDocument();
    });

    fetchSpy.mockRestore();
  });

  it('routes local-page diagram edit fetch to /api/local-attachments (#302 Gap 4)', async () => {
    // Standalone/local page: no confluenceId → handleEditDiagram must hit
    // /api/local-attachments, not /api/attachments (which would 404).
    currentMockPage = { ...mockPage, confluenceId: null as unknown as string };

    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const fakeResponse = {
      ok: true,
      status: 200,
      blob: () => Promise.resolve(pngBlob),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse);

    render(<PageViewPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('edit-diagram-trigger'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/local-attachments/page-1/my-diagram.png');
    expect(String(url)).not.toMatch(/\/api\/attachments\//);

    fetchSpy.mockRestore();
  });

  it('routes Confluence-page diagram edit fetch to /api/attachments', async () => {
    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const fakeResponse = {
      ok: true,
      status: 200,
      blob: () => Promise.resolve(pngBlob),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse);

    render(<PageViewPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('edit-diagram-trigger'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/attachments/98765432/my-diagram.png');

    fetchSpy.mockRestore();
  });

  it('routes local-page diagram save PUT to /local-attachments (#302 Gap 4)', async () => {
    // Standalone/local page: handleDrawioSave must PUT to /local-attachments.
    currentMockPage = { ...mockPage, confluenceId: null as unknown as string };

    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const fakeResponse = {
      ok: true,
      status: 200,
      blob: () => Promise.resolve(pngBlob),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse);

    render(<PageViewPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('edit-diagram-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('drawio-save-trigger')).toBeInTheDocument();
    });

    // Clear mount-time apiFetch calls (e.g. /settings/drawio-url) so the
    // next recorded call is the diagram save.
    vi.mocked(apiFetch).mockClear();
    fireEvent.click(screen.getByTestId('drawio-save-trigger'));

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalled();
    });
    const saveCall = vi
      .mocked(apiFetch)
      .mock.calls.find(([path]) => String(path).includes('my-diagram.png'));
    expect(saveCall).toBeDefined();
    const [path, options] = saveCall!;
    expect(path).toBe('/local-attachments/page-1/my-diagram.png');
    expect(options?.method).toBe('PUT');
    expect(String(path)).not.toMatch(/^\/attachments\//);

    fetchSpy.mockRestore();
  });

  it('routes Confluence-page diagram save PUT to /attachments', async () => {
    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const fakeResponse = {
      ok: true,
      status: 200,
      blob: () => Promise.resolve(pngBlob),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse);

    render(<PageViewPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('edit-diagram-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('drawio-save-trigger')).toBeInTheDocument();
    });

    vi.mocked(apiFetch).mockClear();
    fireEvent.click(screen.getByTestId('drawio-save-trigger'));

    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalled();
    });
    const saveCall = vi
      .mocked(apiFetch)
      .mock.calls.find(([path]) => String(path).includes('my-diagram.png'));
    expect(saveCall).toBeDefined();
    const [path, options] = saveCall!;
    expect(path).toBe('/attachments/98765432/my-diagram.png');
    expect(options?.method).toBe('PUT');

    fetchSpy.mockRestore();
  });

  it('shows Edit button for pages with pageType "folder" (folder concept removed)', () => {
    currentMockPage = { ...mockPage, pageType: 'folder' as const };
    render(<PageViewPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('shows empty page placeholder when bodyHtml is empty', () => {
    currentMockPage = { ...mockPage, bodyHtml: '' };
    render(<PageViewPage />, { wrapper: createWrapper() });
    expect(screen.getByText('This page has no content yet.')).toBeInTheDocument();
    expect(screen.getByTestId('add-content-btn')).toBeInTheDocument();
  });

  it('shows empty page placeholder when bodyHtml is whitespace-only', () => {
    currentMockPage = { ...mockPage, bodyHtml: '   \n  ' };
    render(<PageViewPage />, { wrapper: createWrapper() });
    expect(screen.getByText('This page has no content yet.')).toBeInTheDocument();
    expect(screen.getByTestId('add-content-btn')).toBeInTheDocument();
  });

  it('shows empty page placeholder when bodyHtml is just <p></p>', () => {
    currentMockPage = { ...mockPage, bodyHtml: '<p></p>' };
    render(<PageViewPage />, { wrapper: createWrapper() });
    expect(screen.getByText('This page has no content yet.')).toBeInTheDocument();
    expect(screen.getByTestId('add-content-btn')).toBeInTheDocument();
  });

  it('Add content button enters inline edit mode instead of navigating', async () => {
    currentMockPage = { ...mockPage, bodyHtml: '' };
    render(<PageViewPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('add-content-btn'));

    // Should enter edit mode (shows Save/Cancel), not navigate to a non-existent route
    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows article content when bodyHtml has content', () => {
    currentMockPage = { ...mockPage, bodyHtml: '<p>Some content</p>' };
    render(<PageViewPage />, { wrapper: createWrapper() });
    expect(screen.queryByText('This page has no content yet.')).not.toBeInTheDocument();
    expect(screen.getByTestId('article-viewer')).toBeInTheDocument();
  });

  // --- Phase 5: Action shortcuts ---
  it('registers an Alt+P shortcut for pin/unpin', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const pinShortcut = capturedShortcuts.find((s) => s.key === 'Alt+P');
    expect(pinShortcut).toBeDefined();
    expect(pinShortcut!.alt).toBe(true);
    expect(pinShortcut!.keys).toContain('p');
    expect(pinShortcut!.category).toBe('actions');
  });

  it('Alt+P action calls pin mutation', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const pinShortcut = capturedShortcuts.find((s) => s.key === 'Alt+P');
    expect(pinShortcut).toBeDefined();
    pinShortcut!.action();
    expect(mockPinMutate).toHaveBeenCalledWith('page-1', expect.any(Object));
  });

  it('registers an Alt+Shift+D shortcut for delete', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const deleteShortcut = capturedShortcuts.find((s) => s.key === 'Alt+Shift+D');
    expect(deleteShortcut).toBeDefined();
    expect(deleteShortcut!.alt).toBe(true);
    expect(deleteShortcut!.shift).toBe(true);
    expect(deleteShortcut!.category).toBe('actions');
  });

  it('Alt+Shift+D opens the move-to-trash dialog; confirming soft-deletes the page', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const deleteShortcut = capturedShortcuts.find((s) => s.key === 'Alt+Shift+D');
    expect(deleteShortcut).toBeDefined();
    act(() => {
      deleteShortcut!.action();
    });

    // ConfirmDialog replaces native confirm() — copy must reflect the 30-day
    // soft-delete trash, not the old (false) "cannot be undone" claim.
    expect(await screen.findByText('Move page to trash?')).toBeInTheDocument();
    expect(
      screen.getByText('It can be restored from Trash for 30 days, then it is permanently deleted.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('page-1');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('cancelling the move-to-trash dialog does not delete', async () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const deleteShortcut = capturedShortcuts.find((s) => s.key === 'Alt+Shift+D');
    expect(deleteShortcut).toBeDefined();
    act(() => {
      deleteShortcut!.action();
    });

    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });

  it('registers an Alt+I shortcut for AI Improve', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const aiShortcut = capturedShortcuts.find((s) => s.key === 'Alt+I');
    expect(aiShortcut).toBeDefined();
    expect(aiShortcut!.alt).toBe(true);
    expect(aiShortcut!.keys).toContain('i');
    expect(aiShortcut!.category).toBe('actions');
  });

  it('Alt+I action navigates to AI improve page', () => {
    render(<PageViewPage />, { wrapper: createWrapper() });
    const aiShortcut = capturedShortcuts.find((s) => s.key === 'Alt+I');
    expect(aiShortcut).toBeDefined();
    aiShortcut!.action();
    expect(mockNavigate).toHaveBeenCalledWith('/ai?mode=improve&pageId=page-1');
  });

  // #703 / #769 — the sticky edit toolbar carries an opaque bg-background
  // under-mask (z-[-1]) covering exactly the toolbar's box (inset-0), the
  // same pattern as /ai's sticky bars. The toolbar pins flush at the
  // scrollport top, so the mask must not extend past the toolbar's box:
  // negative inset offsets push the absolutely positioned mask outside the
  // scroll container's content edge (the pattern that caused /ai's phantom
  // vertical scroll).
  describe('sticky edit-toolbar under-mask (#703, #769)', () => {
    it('renders an opaque under-mask behind the edit toolbar covering exactly its box', () => {
      const { container } = render(<PageViewPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByText('Edit'));

      // The sticky toolbar wrapper establishes its own stacking context
      // (isolate) so the negative-z mask sits behind it, not behind the page.
      const toolbar = container.querySelector('.sticky.top-0');
      expect(toolbar).not.toBeNull();
      expect(toolbar!.className).toContain('isolate');

      const mask = toolbar!.querySelector('[aria-hidden]');
      expect(mask).not.toBeNull();
      expect(mask!.className).toContain('bg-background');
      expect(mask!.className).not.toContain('bg-background/');
      expect(mask!.className).toContain('z-[-1]');
      expect(mask!.className).toContain('inset-0');
      expect(mask!.className).toContain('pointer-events-none');
    });

    it('the under-mask does not extend past the toolbar (regression: #769 phantom scroll)', () => {
      const { container } = render(<PageViewPage />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByText('Edit'));

      const mask = container.querySelector('.sticky.top-0 [aria-hidden]') as HTMLElement;
      expect(mask).not.toBeNull();
      // Forbid both negative-utility (-top-[100px]) and arbitrary-negative
      // (top-[-100px]) spellings, plus inline style offsets.
      expect(mask.className).not.toMatch(/-(top|bottom|left|right|inset(-[xy])?)-\[/);
      expect(mask.className).not.toMatch(/\b(top|bottom|left|right|inset(-[xy])?)-\[-/);
      expect(mask.style.top).toBe('');
      expect(mask.style.bottom).toBe('');
    });
  });

  // Task 5 — drafts read as a personal/private state, not an AI affordance, so
  // the Draft badge must use the neutral private-tier palette (no
  // orange/amber/primary). The Playwright contrast spec in Task 6 will catch
  // the colour combo at run-time; this guards the contract at the unit level.
  it('Draft badge uses neutral private-tier palette, not orange/amber', () => {
    currentMockPage = { ...mockPage, hasDraft: true } as typeof mockPage;
    try {
      render(<PageViewPage />, { wrapper: createWrapper() });
      const badge = screen.getByTestId('badge-draft');
      expect(badge.className).not.toMatch(/orange|amber|primary|warning|yellow/);
      expect(badge.className).toMatch(/bg-\[#ececea\]/);
      expect(badge.className).toMatch(/text-\[#4a4a48\]/);
    } finally {
      currentMockPage = mockPage;
    }
  });

  // ConfirmDialog replaces the native confirm() draft-restore prompt. Drafts are
  // autosaved to localStorage on this device; restoring is non-destructive, and
  // declining simply opens the editor on the published content (matching the
  // old confirm() semantics — both paths enter edit mode).
  describe('draft restore dialog', () => {
    it('opens a restore-draft dialog instead of entering edit mode when a differing draft exists', async () => {
      mockDraftContent = '<p>Draft content</p>';
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));

      expect(await screen.findByText('Restore draft?')).toBeInTheDocument();
      // Honest copy: drafts live in this browser; no false destruction claims.
      expect(screen.getByText(/unsaved draft of this page was found/i)).toBeInTheDocument();
      // Edit mode is NOT entered until the user decides.
      expect(screen.queryByLabelText('Article editor')).not.toBeInTheDocument();

      // Close the portal dialog before teardown — this file's afterEach wipes
      // document.body, which races React's portal unmount if it's still open.
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
    });

    it('confirming restores the draft into the editor', async () => {
      mockDraftContent = '<p>Draft content</p>';
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      await screen.findByTestId('confirm-dialog');
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(screen.getByLabelText('Article editor')).toHaveValue('<p>Draft content</p>');
      });
    });

    it('cancelling opens the editor on the published content instead', async () => {
      mockDraftContent = '<p>Draft content</p>';
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      await screen.findByTestId('confirm-dialog');
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

      await waitFor(() => {
        expect(screen.getByLabelText('Article editor')).toHaveValue(mockPage.bodyHtml);
      });
    });

    it('dismissing with Escape stays in view mode and keeps the draft pending', async () => {
      // Escape must mean "do nothing": entering edit mode on the published
      // copy would let autosave start overwriting the stored draft, which is
      // a side effect nobody chose.
      mockDraftContent = '<p>Draft content</p>';
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      await screen.findByTestId('confirm-dialog');
      fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
      // Still in view mode — no editor mounted.
      expect(screen.queryByLabelText('Article editor')).not.toBeInTheDocument();

      // The decision was deferred, not made: Edit prompts again.
      fireEvent.click(screen.getByText('Edit'));
      expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument();

      // Close the portal dialog before teardown (see first test in this block).
      fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
    });

    it('enters edit mode directly when no draft exists', () => {
      mockDraftContent = null;
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));

      expect(screen.getByLabelText('Article editor')).toBeInTheDocument();
      expect(screen.queryByText('Restore draft?')).not.toBeInTheDocument();
    });

    it('enters edit mode directly when the draft matches the published content', () => {
      mockDraftContent = mockPage.bodyHtml;
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));

      expect(screen.getByLabelText('Article editor')).toBeInTheDocument();
      expect(screen.queryByText('Restore draft?')).not.toBeInTheDocument();
    });
  });

  // #944 — Cancel in the editor must not silently discard unsaved work. When
  // the working title/body diverges from the persisted page, Cancel opens a
  // destructive discard confirmation instead of dropping out of edit mode.
  // A pristine editor (no edits) still exits immediately.
  describe('cancel discard confirmation', () => {
    it('prompts before discarding when the editor has unsaved changes', async () => {
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByLabelText('Article editor'), {
        target: { value: '<p>rewritten</p>' },
      });
      fireEvent.click(screen.getByText('Cancel'));

      // The discard confirmation appears and the editor stays mounted — the
      // work is NOT thrown away until the user confirms.
      expect(await screen.findByText('Discard changes?')).toBeInTheDocument();
      expect(screen.getByLabelText('Article editor')).toBeInTheDocument();

      // Close the portal dialog before teardown (afterEach wipes document.body).
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
    });

    it('confirming the discard exits edit mode', async () => {
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByLabelText('Article editor'), {
        target: { value: '<p>rewritten</p>' },
      });
      fireEvent.click(screen.getByText('Cancel'));

      await screen.findByText('Discard changes?');
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

      await waitFor(() => {
        expect(screen.queryByLabelText('Article editor')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('keeps editing when the discard dialog is dismissed', async () => {
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByLabelText('Article editor'), {
        target: { value: '<p>rewritten</p>' },
      });
      fireEvent.click(screen.getByText('Cancel'));

      await screen.findByText('Discard changes?');
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      });
      // Still editing — the work is preserved.
      expect(screen.getByLabelText('Article editor')).toBeInTheDocument();
    });

    it('exits immediately without a prompt when the editor is pristine', async () => {
      render(<PageViewPage />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByText('Edit'));
      // No edits made — Cancel should exit straight to view mode.
      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() => {
        expect(screen.queryByLabelText('Article editor')).not.toBeInTheDocument();
      });
      expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument();
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });
  });

  // #872 — The /pages/:id route is not keyed, so React Router keeps a single
  // PageViewPage instance mounted across :id changes. Edit-mode state
  // (editing/editTitle/editHtml) is component-local and was never reset on
  // id change, so navigating mid-edit left page A's title+body loaded while
  // viewing page B — and saving then overwrote page B with page A's content.
  describe('edit-mode reset on route param change (#872)', () => {
    it('resets edit state when the :id param changes mid-edit', async () => {
      // A data router keeps the same PageViewPage instance mounted across
      // param changes (matching production where App.tsx renders one
      // un-keyed <Route path="/pages/:id">). router.navigate() drives the
      // real useParams(), bypassing this file's mocked useNavigate.
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const router = createMemoryRouter(
        [{ path: '/pages/:id', element: <PageViewPage /> }],
        { initialEntries: ['/pages/page-1'] },
      );

      currentMockPage = mockPage; // page A: "Engineering Handbook", version 7
      render(
        <QueryClientProvider client={queryClient}>
          <LazyMotion features={domAnimation}>
            <RouterProvider router={router} />
          </LazyMotion>
        </QueryClientProvider>,
      );

      // Enter edit mode on page A — editor mounts with A's title/body.
      fireEvent.click(screen.getByText('Edit'));
      expect(screen.getByLabelText('Article editor')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Engineering Handbook')).toBeInTheDocument();

      // Navigate to page B while still in edit mode. The instance stays
      // mounted; only the :id param + page data change.
      currentMockPage = {
        ...mockPage,
        id: 'page-2',
        title: 'Runbook',
        bodyHtml: '<p>B</p>',
        version: 3,
      };
      await act(async () => {
        await router.navigate('/pages/page-2');
      });

      // Edit mode must have exited — no stale editor holding page A's body.
      expect(screen.queryByLabelText('Article editor')).not.toBeInTheDocument();
      expect(screen.getByText('Edit')).toBeInTheDocument();

      // Corruption guard: a Ctrl+S after navigation must not push page A's
      // title onto page B. Pre-fix, editing stayed true and Save fired
      // { id: 'page-2', title: 'Engineering Handbook', version: 3 }.
      const saveShortcut = capturedShortcuts.find((s) => s.key === 'Ctrl+S');
      expect(saveShortcut).toBeDefined();
      await act(async () => {
        saveShortcut!.action();
      });
      expect(mockUpdatePage).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Engineering Handbook' }),
      );
    });

    // #872 follow-up — the confirmation dialogs (Discard changes? / Move to
    // trash?) are rendered outside the `editing` branch, so the edit-state
    // reset alone left them open across a route change. A dialog left open
    // then acted against page B's draftKey/id (deleting page B's draft or
    // trashing page B), e.g. after the user hit Cancel then browser-Back.
    it('dismisses an open discard-confirmation dialog when the :id param changes', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const router = createMemoryRouter(
        [{ path: '/pages/:id', element: <PageViewPage /> }],
        { initialEntries: ['/pages/page-1'] },
      );

      currentMockPage = mockPage; // page A
      render(
        <QueryClientProvider client={queryClient}>
          <LazyMotion features={domAnimation}>
            <RouterProvider router={router} />
          </LazyMotion>
        </QueryClientProvider>,
      );

      // Enter edit mode on page A and dirty it so Cancel opens the discard
      // confirmation (instead of exiting straight to view mode).
      fireEvent.click(screen.getByText('Edit'));
      fireEvent.change(screen.getByLabelText('Article editor'), {
        target: { value: '<p>rewritten page A</p>' },
      });
      fireEvent.click(screen.getByText('Cancel'));
      expect(await screen.findByText('Discard changes?')).toBeInTheDocument();

      // Navigate to page B while the discard dialog is still open.
      currentMockPage = {
        ...mockPage,
        id: 'page-2',
        title: 'Runbook',
        bodyHtml: '<p>B</p>',
        version: 3,
      };
      await act(async () => {
        await router.navigate('/pages/page-2');
      });

      // The dialog must be dismissed on navigation — otherwise its Discard
      // action would run against page B's draftKey (clearing page B's draft).
      // No dialog means the confirm control is gone, so it cannot act on B.
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument();
      expect(screen.queryByTestId('confirm-dialog-confirm')).not.toBeInTheDocument();
    });

    it('dismisses an open move-to-trash dialog when the :id param changes', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const router = createMemoryRouter(
        [{ path: '/pages/:id', element: <PageViewPage /> }],
        { initialEntries: ['/pages/page-1'] },
      );

      currentMockPage = mockPage; // page A
      render(
        <QueryClientProvider client={queryClient}>
          <LazyMotion features={domAnimation}>
            <RouterProvider router={router} />
          </LazyMotion>
        </QueryClientProvider>,
      );

      const deleteShortcut = capturedShortcuts.find((s) => s.key === 'Alt+Shift+D');
      expect(deleteShortcut).toBeDefined();
      act(() => {
        deleteShortcut!.action();
      });
      expect(await screen.findByText('Move page to trash?')).toBeInTheDocument();

      currentMockPage = {
        ...mockPage,
        id: 'page-2',
        title: 'Runbook',
        bodyHtml: '<p>B</p>',
        version: 3,
      };
      await act(async () => {
        await router.navigate('/pages/page-2');
      });

      // Left open, confirming would trash page B (mutateAsync(id) with the
      // new id). It must be dismissed on navigation instead.
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Move page to trash?')).not.toBeInTheDocument();
      expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
    });
  });

  // #943 — In-place refetches of the SAME page (tag add/remove, resync,
  // requality, drawio save → invalidateQueries(['pages', id])) hand React a
  // fresh page object with an unchanged id + version. The scroll-reset effect
  // must key off navigation (id / version), not the page object identity;
  // otherwise every background invalidation yanks the reader's scroll position
  // back to the top of the article. A version bump (a genuinely new revision)
  // still resets, matching navigation semantics.
  describe('scroll position preservation on in-place refetch (#943)', () => {
    it('does not reset scroll when the page object changes but id + version are unchanged', async () => {
      const scrollContainer = document.createElement('div');
      scrollContainer.setAttribute('data-scroll-container', '');
      document.body.appendChild(scrollContainer);
      const scrollSpy = vi.spyOn(scrollContainer, 'scrollTo');

      currentMockPage = mockPage;
      const { rerender } = render(<PageViewPage />, { wrapper: createWrapper() });

      // Initial mount scrolls to top (navigation reset). Wait for it, then
      // clear the spy so we only observe the refetch behaviour.
      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
      });
      scrollSpy.mockClear();

      // Simulate an optimistic write / invalidation: a brand-new page object
      // with the SAME id and version (e.g. a label was added).
      currentMockPage = {
        ...mockPage,
        labels: [...mockPage.labels, 'newly-added'],
      };
      rerender(<PageViewPage />);

      // Give any effects + double-rAF a chance to fire, then assert the scroll
      // container was NOT reset — the reader keeps their place.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(scrollSpy).not.toHaveBeenCalled();

      scrollContainer.remove();
    });

    it('still resets scroll when the page version changes (a genuine new revision)', async () => {
      const scrollContainer = document.createElement('div');
      scrollContainer.setAttribute('data-scroll-container', '');
      document.body.appendChild(scrollContainer);
      const scrollSpy = vi.spyOn(scrollContainer, 'scrollTo');

      currentMockPage = mockPage;
      const { rerender } = render(<PageViewPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
      });
      scrollSpy.mockClear();

      currentMockPage = { ...mockPage, version: mockPage.version + 1 };
      rerender(<PageViewPage />);

      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
      });

      scrollContainer.remove();
    });
  });

});

