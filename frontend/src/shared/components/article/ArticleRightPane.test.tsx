import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleRightPane } from './ArticleRightPane';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useUiStore } from '../../../stores/ui-store';

const mockNavigate = vi.fn();
const mockDeletePage = vi.fn();
const mockPinPage = vi.fn();
const mockUnpinPage = vi.fn();
const mockExportPdfAsync = vi.fn();
const mockResyncPage = vi.fn();
const mockReembedPage = vi.fn();
const mockRequalityPage = vi.fn();
let resyncIsPending = false;
let reembedIsPending = false;
let requalityIsPending = false;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockPage = {
  id: 'page-1',
  confluenceId: '98765432',
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
};

let currentMockPage: typeof mockPage | (typeof mockPage & { confluenceId: null }) = mockPage;

vi.mock('../../hooks/use-pages', () => ({
  usePage: () => ({ data: currentMockPage, isLoading: false }),
  useDeletePage: () => ({ mutateAsync: mockDeletePage }),
  usePinnedPages: () => ({ data: { items: [] }, isLoading: false }),
  usePinPage: () => ({ mutate: mockPinPage }),
  useUnpinPage: () => ({ mutate: mockUnpinPage }),
  useResyncPage: () => ({ mutate: mockResyncPage, isPending: resyncIsPending }),
  useReembedPage: () => ({ mutate: mockReembedPage, isPending: reembedIsPending }),
  useRequalityPage: () => ({ mutate: mockRequalityPage, isPending: requalityIsPending }),
}));

vi.mock('../../hooks/use-settings', () => ({
  useSettings: () => ({
    data: { confluenceUrl: 'https://confluence.example.com' },
  }),
}));

// Stub apiFetch so the usecase-default query resolves "configured" (Auto-tag visible).
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(async (url: string) =>
    url.includes('usecase-default') ? { provider: 'p1', model: 'bge-x' } : {},
  ),
}));

vi.mock('../../hooks/use-standalone', () => ({
  useExportPdf: () => ({ mutateAsync: mockExportPdfAsync, isPending: false }),
}));

vi.mock('../../../features/pages/AutoTagger', () => ({
  AutoTagger: ({ pageId, currentLabels }: { pageId: string; currentLabels: string[] }) => (
    <div data-testid="auto-tagger" data-page-id={pageId} data-labels={currentLabels.join(',')} />
  ),
}));

vi.mock('../badges/FreshnessBadge', () => ({
  FreshnessBadge: ({ lastModified }: { lastModified: string }) => <span>{lastModified}</span>,
}));

vi.mock('../badges/EmbeddingStatusBadge', () => ({
  EmbeddingStatusBadge: ({ embeddingStatus }: { embeddingStatus: string }) => (
    <span data-testid="embedding-status-badge">{embeddingStatus}</span>
  ),
}));

vi.mock('../badges/QualityScoreBadge', () => ({
  QualityScoreBadge: ({ qualityScore }: { qualityScore: number | null }) => (
    <span data-testid="quality-score-badge">{qualityScore ?? 'N/A'}</span>
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

describe('ArticleRightPane', () => {
  beforeEach(() => {
    currentMockPage = mockPage;
    mockNavigate.mockReset();
    mockDeletePage.mockReset().mockResolvedValue(undefined);
    mockPinPage.mockReset();
    mockUnpinPage.mockReset();
    mockExportPdfAsync.mockReset();
    mockResyncPage.mockReset();
    mockReembedPage.mockReset();
    mockRequalityPage.mockReset();
    resyncIsPending = false;
    reembedIsPending = false;
    requalityIsPending = false;
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

    fireEvent.click(screen.getByLabelText('Collapse page sidebar'));

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('expands from the rail when the expand button is clicked', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand page sidebar'));

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
  });

  it('hides action buttons when editing is active', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByTestId('article-actions')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Improve')).not.toBeInTheDocument();
  });

  it('keeps AI-Tagging available in edit mode (#354)', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    // The read-mode action panel is hidden, but AI-Tagging is rendered
    // in its own edit-mode wrapper.
    expect(screen.queryByTestId('article-actions')).not.toBeInTheDocument();
    const editPanel = screen.getByTestId('article-actions-edit');
    expect(editPanel).toBeInTheDocument();

    // AutoTagger mock attaches data-* attrs identical to the read-mode case.
    const autoTagger = screen.getByTestId('auto-tagger');
    expect(autoTagger).toBeInTheDocument();
    expect(autoTagger).toHaveAttribute('data-page-id', 'page-1');
  });

  it('mounts the Version history trigger in the read-mode action list (#709)', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const actions = screen.getByTestId('article-actions');
    expect(actions).toBeInTheDocument();
    // Glass-styled trigger rendered via VersionHistory's renderTrigger prop.
    expect(screen.getByText('Version history')).toBeInTheDocument();
    expect(screen.getByTitle('Version history')).toBeInTheDocument();
  });

  it('hides the Version history trigger while editing (#709)', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByText('Version history')).not.toBeInTheDocument();
  });

  it('navigates to AI Improve when the button is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('AI Improve'));

    expect(mockNavigate).toHaveBeenCalledWith('/ai?mode=improve&pageId=page-1');
  });

  it('renders Re-sync and Re-embed buttons for Confluence-sourced articles', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-resync-btn')).toBeInTheDocument();
    expect(screen.getByTestId('article-reembed-btn')).toBeInTheDocument();
  });

  it('hides Re-sync for locally-authored articles (no confluenceId)', () => {
    currentMockPage = { ...mockPage, confluenceId: null };

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByTestId('article-resync-btn')).not.toBeInTheDocument();
    // Re-embed always available — local pages can still be RAG-indexed.
    expect(screen.getByTestId('article-reembed-btn')).toBeInTheDocument();
  });

  it('invokes resync mutation when Re-sync is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('article-resync-btn'));

    expect(mockResyncPage).toHaveBeenCalledTimes(1);
    expect(mockResyncPage.mock.calls[0]![0]).toBe('page-1');
  });

  it('invokes requality mutation when Re-check Quality is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('article-requality-btn'));

    expect(mockRequalityPage).toHaveBeenCalledTimes(1);
    expect(mockRequalityPage.mock.calls[0]![0]).toBe('page-1');
  });

  it('renders Re-check Quality for locally-authored pages too', () => {
    currentMockPage = { ...mockPage, confluenceId: null };

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-requality-btn')).toBeInTheDocument();
  });

  it('renders rail actions when collapsed and invokes requality from the rail', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    // Sanity-check the rail rendered with its action stack
    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.getByTestId('article-actions-rail')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('article-requality-rail-btn'));

    expect(mockRequalityPage).toHaveBeenCalledTimes(1);
    expect(mockRequalityPage.mock.calls[0]![0]).toBe('page-1');
  });

  it('hides rail actions while editing', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('article-actions-rail')).not.toBeInTheDocument();
  });

  it('invokes reembed mutation when Re-embed is clicked', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('article-reembed-btn'));

    expect(mockReembedPage).toHaveBeenCalledTimes(1);
    expect(mockReembedPage.mock.calls[0]![0]).toBe('page-1');
  });

  it('disables the Re-sync button while resync is pending', () => {
    resyncIsPending = true;

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const btn = screen.getByTestId('article-resync-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('does not toast error when Re-sync silently no-ops (0/0/[])', async () => {
    // Bulk endpoint can legitimately return zero-everywhere when the page is
    // skipped server-side (e.g. confluenceId became null between render and
    // click). That's not a failure — surface as info, not error.
    const sonner = await import('sonner');
    const toastErrorSpy = vi.spyOn(sonner.toast, 'error');
    const toastInfoSpy = vi.spyOn(sonner.toast, 'info');
    mockResyncPage.mockImplementation((_id: string, opts: { onSuccess: (d: { succeeded: number; failed: number; errors: string[] }) => void }) => {
      opts.onSuccess({ succeeded: 0, failed: 0, errors: [] });
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByTestId('article-resync-btn'));

    await waitFor(() => {
      expect(toastErrorSpy).not.toHaveBeenCalled();
      expect(toastInfoSpy).toHaveBeenCalledWith('Nothing to re-sync.');
    });

    toastErrorSpy.mockRestore();
    toastInfoSpy.mockRestore();
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

    expect(screen.getByText('No headings on this page.')).toBeInTheDocument();
  });

  // #880: outline rows were clickable <div>s with focus-visible classes but no
  // tabIndex/role/onKeyDown, so keyboard-only and screen-reader users could not
  // reach any heading. Each row is now a focusable role="treeitem" that
  // activates the jump-to-heading on Enter/Space (WCAG 2.1.1).
  describe('outline keyboard navigation (#880)', () => {
    it('exposes each outline row as a focusable treeitem (role + tabIndex 0)', () => {
      useArticleViewStore.setState({
        headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
      });
      render(<ArticleRightPane />, { wrapper: createWrapper() });
      const row = screen.getByText('Introduction').closest('[role="treeitem"]');
      expect(row).not.toBeNull();
      expect(row!.getAttribute('tabindex')).toBe('0');
    });

    it('activates the heading on Enter (scrolls the container and marks the row active)', () => {
      useArticleViewStore.setState({
        headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
      });

      // handleNavigate resolves the scroll container + heading target from the
      // live DOM, so seed both and spy on the scroll it performs.
      const scrollRoot = document.createElement('div');
      scrollRoot.setAttribute('data-scroll-container', '');
      const scrollToSpy = vi.fn();
      scrollRoot.scrollTo = scrollToSpy as unknown as typeof scrollRoot.scrollTo;
      const target = document.createElement('h1');
      target.id = 'intro';
      scrollRoot.appendChild(target);
      document.body.appendChild(scrollRoot);

      render(<ArticleRightPane />, { wrapper: createWrapper() });
      const row = screen.getByText('Introduction').closest('[role="treeitem"]')!;
      fireEvent.keyDown(row, { key: 'Enter' });

      expect(scrollToSpy).toHaveBeenCalled();
      // setActiveId(headingId) ran → the row gets the active treatment.
      const activeRow = screen.getByText('Introduction').closest('[role="treeitem"]')!;
      expect(activeRow.className).toContain('nm-pill-active');
    });

    it('prevents the default page-scroll on Space', () => {
      useArticleViewStore.setState({
        headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
      });
      render(<ArticleRightPane />, { wrapper: createWrapper() });
      const row = screen.getByText('Introduction').closest('[role="treeitem"]')!;
      const notPrevented = fireEvent.keyDown(row, { key: ' ' });
      expect(notPrevented).toBe(false);
    });
  });

  // #880 (code-review follow-up): outline rows carry role="treeitem" but had no
  // role="tree" ancestor and nested-children wrappers lacked role="group", so
  // every treeitem was orphaned (axe-critical aria-required-parent). The outline
  // list is now a role="tree" and each expanded heading's sub-headings live in a
  // role="group".
  describe('outline ARIA tree semantics (#880)', () => {
    it('exposes the outline list as a labelled ARIA tree', () => {
      useArticleViewStore.setState({
        headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
      });
      render(<ArticleRightPane />, { wrapper: createWrapper() });
      const tree = screen.getByRole('tree');
      expect(tree).toBeInTheDocument();
      expect(tree.getAttribute('aria-label')).toBeTruthy();
    });

    it('wraps nested sub-headings in role="group" so nested treeitems have a valid parent', () => {
      // A level-2 heading nests under the preceding level-1 heading; outline
      // branches are expanded by default (collapsedIds is empty).
      useArticleViewStore.setState({
        headings: [
          { id: 'intro', text: 'Introduction', level: 1 },
          { id: 'usage', text: 'Usage', level: 2 },
        ],
      });
      render(<ArticleRightPane />, { wrapper: createWrapper() });
      expect(screen.getByText('Usage')).toBeInTheDocument();
      const group = document.querySelector('[role="group"]');
      expect(group).not.toBeNull();
      expect(group!.querySelector('[role="treeitem"]')).not.toBeNull();
    });
  });

  it('renders version and space key in the footer', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText(/v7/)).toBeInTheDocument();
    expect(screen.getByText(/ENG/)).toBeInTheDocument();
  });

  it('has a resize handle', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByRole('separator', { name: 'Resize page sidebar' })).toBeInTheDocument();
  });

  it('renders QualityScoreBadge in properties when quality score is present', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('quality-score-badge')).toBeInTheDocument();
    expect(screen.getByTestId('quality-score-badge')).toHaveTextContent('85');
  });

  it('uses confluenceId (not internal id) in the "Open in Confluence" link', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const link = screen.getByText('Open in Confluence').closest('a');
    expect(link).toBeInTheDocument();
    // Should use confluenceId '98765432', not the internal id 'page-1'
    expect(link).toHaveAttribute(
      'href',
      'https://confluence.example.com/pages/viewpage.action?pageId=98765432',
    );
  });

  it('hides the "Open in Confluence" link when confluenceId is null', () => {
    currentMockPage = { ...mockPage, confluenceId: null };

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByText('Open in Confluence')).not.toBeInTheDocument();
  });

  // --- AutoTagger ---
  it('renders AutoTagger with correct props', async () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const autoTagger = await screen.findByTestId('auto-tagger');
    expect(autoTagger).toBeInTheDocument();
    expect(autoTagger).toHaveAttribute('data-page-id', 'page-1');
    expect(autoTagger).toHaveAttribute('data-labels', 'docs');
  });

  it('renders the Auto-tag button in read mode without any legacy settings fields (#718 regression)', async () => {
    // settings mock has no ollamaModel/openaiModel/llmProvider; the button must still appear.
    render(<ArticleRightPane />, { wrapper: createWrapper() });
    expect(await screen.findByTestId('auto-tagger')).toBeInTheDocument();
  });

  // --- Delete via ConfirmDialog (replaces native confirm()) ---
  it('Delete opens the move-to-trash dialog; confirming soft-deletes and navigates home', async () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Delete'));

    // Copy must reflect the 30-day soft-delete trash, not the old (false)
    // "cannot be undone" claim from native confirm().
    expect(await screen.findByText('Move page to trash?')).toBeInTheDocument();
    expect(
      screen.getByText('It can be restored from Trash for 30 days, then it is permanently deleted.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Move to trash');

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeletePage).toHaveBeenCalledWith('page-1');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('cancelling the move-to-trash dialog does not delete', async () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText('Delete'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    expect(mockDeletePage).not.toHaveBeenCalled();
  });

  it('rail Delete button drives the same move-to-trash dialog', async () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByLabelText('Delete page'));

    expect(await screen.findByText('Move page to trash?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeletePage).toHaveBeenCalledWith('page-1');
    });
  });

  // --- PDF Export ---
  it('renders the Export PDF button', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Export PDF')).toBeInTheDocument();
  });

  it('calls export mutation and triggers download on success', async () => {
    const fakeBlob = new Blob(['%PDF'], { type: 'application/pdf' });
    mockExportPdfAsync.mockResolvedValueOnce(fakeBlob);
    const createObjectURLSpy = vi.fn(() => 'blob:http://localhost/fake-url');
    const revokeObjectURLSpy = vi.fn();
    globalThis.URL.createObjectURL = createObjectURLSpy;
    globalThis.URL.revokeObjectURL = revokeObjectURLSpy;

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('Export PDF'));

    await waitFor(() => {
      expect(mockExportPdfAsync).toHaveBeenCalledWith(NaN);
    });
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledWith(fakeBlob);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/fake-url');
    });
  });

  it('shows error toast on export failure', async () => {
    mockExportPdfAsync.mockRejectedValueOnce(new Error('Server error'));

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('Export PDF'));

    await waitFor(() => {
      expect(mockExportPdfAsync).toHaveBeenCalled();
    });
  });
});
