import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleRightPane } from './ArticleRightPane';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useUiStore } from '../../../stores/ui-store';
import { useAiDockStore } from '../../../stores/ai-dock-store';

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

// The pane hosts the assistant as a tab now. DockPanel consumes AiContext and
// the whole AI data stack; this file is about the PANE, so the panel is stubbed
// the same way AutoTagger and the badges are. AiDock.test.tsx covers the panel.
vi.mock('../../../features/ai/dock/DockPanel', () => ({
  DockPanel: () => <div data-testid="dock-panel-stub" />,
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
    // The dock forces this pane into its rail while open (#1126), so a test
    // that opens it would otherwise change what every later test renders.
    useAiDockStore.setState({ open: false });
    // jsdom's default. `useIsDockWideLayout` reads it via matchMedia, and the
    // pane steps aside entirely below 1100px while the dock is open.
    window.innerWidth = 1024;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the expanded pane with header and action buttons', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
    // The "Page context" label and the page title under it are gone: the view
    // switcher is the header row now. Both were redundant — the article's own
    // H1 sits a few pixels to the left and never scrolls out from under the
    // context strip. What the header must still carry is the tablist and the
    // collapse control, which is what this asserts instead.
    expect(screen.getByRole('tablist', { name: 'Page context views' })).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse page sidebar')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Pin')).toBeInTheDocument();
    expect(screen.getByText('Open in Confluence')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('keeps primary actions visible and tucks maintenance and deletion behind disclosures', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Export PDF').closest('details')).toBeNull();
    expect(screen.getByText('Pin').closest('details')).toBeNull();

    const moreActions = screen.getByText('More actions').closest('details');
    const dangerZone = screen.getByText('Danger zone').closest('details');
    expect(moreActions).not.toHaveAttribute('open');
    expect(dangerZone).not.toHaveAttribute('open');

    fireEvent.click(screen.getByText('More actions'));
    expect(moreActions).toHaveAttribute('open');
    fireEvent.click(screen.getByText('Danger zone'));
    expect(dangerZone).toHaveAttribute('open');
  });

  it('opens on the outline when the page has document structure', () => {
    useArticleViewStore.setState({
      headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByRole('tab', { name: /Outline/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Introduction')).toBeInTheDocument();
    expect(screen.queryByTestId('article-actions')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByTestId('article-actions')).toBeInTheDocument();
  });

  it('switches between Outline and Details tabs using Alt+O and Alt+D hotkeys', () => {
    useArticleViewStore.setState({
      headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    expect(screen.getByRole('tab', { name: /Outline/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'd', altKey: true });
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'o', altKey: true });
    expect(screen.getByRole('tab', { name: /Outline/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('honors explicit inspector view requests from layout presets', () => {
    useArticleViewStore.setState({
      headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
    });

    const { rerender } = render(
      <ArticleRightPane inspectorViewRequest={{ view: 'details', requestId: 1 }} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');

    rerender(<ArticleRightPane inspectorViewRequest={{ view: 'outline', requestId: 2 }} />);
    expect(screen.getByRole('tab', { name: /Outline/ })).toHaveAttribute('aria-selected', 'true');
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
    // No "AI Assistant" assertion here any more: that control was removed from
    // Page actions, so asserting its absence would pass whether or not editing
    // hides anything — a green cell testing nothing.
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

  // #1126: the way in used to navigate to /ai?mode=improve&pageId=…, taking the
  // document off screen to operate on it. It shows the assistant beside the
  // document instead. #1176: and only shows it — it queues no work.
  //
  // The trigger under test is now the TAB. There was also an "AI Assistant"
  // button in Page actions, which this test used to click; it was removed once
  // the assistant became the tab immediately to its left, since it duplicated
  // the tablist one row below it. Both halves that matter are unchanged: no
  // navigation, and nothing starts on open.
  it('shows the assistant in this pane instead of navigating away, and starts nothing', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('page-context-tab-assistant'));

    expect(screen.getByTestId('page-context-tab-assistant')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // These two cells asserted the opposite until the assistant became a tab: the
  // pane used to collapse to its rail whenever `dockOpen` was set, because the
  // assistant was a third column that needed the room. There is no column now.
  //
  // Re-adding the OR is not a cosmetic regression. `AppLayout` consumes the flag
  // in an effect — after commit — so the pane starts collapsing, and its width is
  // a framer spring: measured per rAF, it ran 280 → 1 → 280 over ~30 frames on
  // the very keystroke meant to open it. jsdom performs no layout, so that is
  // invisible here; what these cells can pin is the cause, which is whether the
  // pane consults `dockOpen` at all.
  it('does not collapse for the dock flag on a wide layout — the assistant is a tab', () => {
    window.innerWidth = 1400;
    useAiDockStore.setState({ open: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
    expect(screen.queryByTestId('article-right-pane-rail')).not.toBeInTheDocument();
    expect(useUiStore.getState().articleSidebarCollapsed).toBe(false);
  });

  it('expands on its own preference alone, without consulting the dock', () => {
    window.innerWidth = 1400;
    useUiStore.setState({ articleSidebarCollapsed: true });
    useAiDockStore.setState({ open: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('Expand page sidebar'));

    expect(useUiStore.getState().articleSidebarCollapsed).toBe(false);
    // Untouched: closing the sheet is `AppLayout`'s job and the `.` shortcut's,
    // not something this pane's expand control reaches sideways to do.
    expect(useAiDockStore.getState().open).toBe(true);
  });

  it('steps aside entirely below the wide breakpoint while the dock is open', () => {
    window.innerWidth = 900;
    useAiDockStore.setState({ open: true });

    const { container } = render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to Details when navigating from a structured page to a heading-free page', async () => {
    useArticleViewStore.setState({
      headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: '/pages/:id', element: <ArticleRightPane /> }],
      { initialEntries: ['/pages/page-1'] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={domAnimation}>
          <RouterProvider router={router} />
        </LazyMotion>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('tab', { name: /Outline/ })).toHaveAttribute('aria-selected', 'true');

    await act(async () => {
      await router.navigate('/pages/page-2');
    });
    act(() => {
      useArticleViewStore.getState().setHeadings([]);
    });

    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('article-actions')).toBeInTheDocument();
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

  // #1126: collapsing this pane drops the outline entirely — the rail only ever
  // carried actions. The flyout is what keeps the outline reachable at 40px,
  // which matters now that opening the dock forces the rail.
  describe('rail outline flyout', () => {
    const headings = [
      { id: 'intro', text: 'Introduction', level: 1 },
      { id: 'usage', text: 'Usage', level: 2 },
    ];

    function renderRail() {
      useUiStore.setState({ articleSidebarCollapsed: true });
      useArticleViewStore.setState({ headings });
      return render(<ArticleRightPane />, { wrapper: createWrapper() });
    }

    it('offers no outline trigger when the article has no headings', () => {
      useUiStore.setState({ articleSidebarCollapsed: true });
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.queryByTestId('article-outline-rail-btn')).not.toBeInTheDocument();
    });

    it('reveals the outline on hover', () => {
      renderRail();
      expect(screen.queryByTestId('article-outline-flyout')).not.toBeInTheDocument();

      fireEvent.mouseEnter(screen.getByTestId('article-outline-rail-btn'));

      expect(screen.getByTestId('article-outline-flyout')).toBeInTheDocument();
      expect(screen.getByText('Introduction')).toBeInTheDocument();
      expect(screen.getByText('2 sections')).toBeInTheDocument();
    });

    // WCAG 2.4.7: a hover-only reveal puts the outline out of reach of the
    // keyboard entirely, so focus has to open it too.
    it('reveals the outline on keyboard focus, not only on hover', () => {
      renderRail();

      fireEvent.focus(screen.getByTestId('article-outline-rail-btn'));

      expect(screen.getByTestId('article-outline-flyout')).toBeInTheDocument();
    });

    // WCAG 1.4.13: content on hover or focus must be dismissible.
    it('dismisses on Escape and returns focus to the trigger', async () => {
      renderRail();
      const trigger = screen.getByTestId('article-outline-rail-btn');
      fireEvent.focus(trigger);
      expect(screen.getByTestId('article-outline-flyout')).toBeInTheDocument();

      fireEvent.keyDown(trigger, { key: 'Escape' });

      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(document.activeElement).toBe(trigger);
      // The panel leaves through AnimatePresence, so it unmounts a frame later.
      await waitFor(() => {
        expect(screen.queryByTestId('article-outline-flyout')).not.toBeInTheDocument();
      });
    });

    it('exposes the trigger as an expandable control naming what it opens', () => {
      renderRail();
      const trigger = screen.getByTestId('article-outline-rail-btn');

      expect(trigger).toHaveAttribute('aria-label', 'Article outline');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveAttribute('aria-controls', 'article-outline-flyout');

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('article-outline-flyout')).toHaveAttribute('id', 'article-outline-flyout');
    });

    it('navigates to a heading from inside the flyout', () => {
      const scrollTo = vi.fn();
      const scrollRoot = document.createElement('div');
      scrollRoot.setAttribute('data-scroll-container', '');
      scrollRoot.scrollTo = scrollTo;
      document.body.appendChild(scrollRoot);
      const target = document.createElement('h2');
      target.id = 'usage';
      scrollRoot.appendChild(target);

      renderRail();
      fireEvent.mouseEnter(screen.getByTestId('article-outline-rail-btn'));
      fireEvent.click(screen.getByText('Usage'));

      expect(scrollTo).toHaveBeenCalled();
      scrollRoot.remove();
    });
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
    expect(screen.getByRole('tab', { name: /Outline/ })).toHaveTextContent('2');
  });

  it('shows empty message when there are no headings', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    expect(screen.getByText('No outline yet')).toBeInTheDocument();
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
      expect(activeRow.className).toContain('nav-selection');
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

    const handle = screen.getByRole('separator', { name: 'Resize page sidebar' });
    expect(handle).toHaveAttribute('aria-valuenow', '280');
    expect(handle).toHaveAttribute('aria-valuemax', '1200');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('supports keyboard resizing and double-click reset', () => {
    useUiStore.setState({ articleSidebarWidth: 320 });
    render(<ArticleRightPane />, { wrapper: createWrapper() });
    const handle = screen.getByRole('separator', { name: 'Resize page sidebar' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().articleSidebarWidth).toBe(336);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().articleSidebarWidth).toBe(320);

    act(() => {
      useUiStore.setState({ articleSidebarWidth: 1195 });
    });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().articleSidebarWidth).toBe(1200);

    fireEvent.doubleClick(handle);
    expect(useUiStore.getState().articleSidebarWidth).toBe(360);
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

  // Behaviour change: the collapsed rail no longer offers Delete at all.
  //
  // Expanded, deleting sits behind a "Danger zone" disclosure and then a
  // confirm dialog. Collapsing the pane used to PROMOTE it to a top-level icon
  // among ten unlabelled glyphs — so the safety around destroying a page was a
  // function of a layout preference. Sharing the confirm (which it did, and
  // which this test used to assert) made the second step identical; it did
  // nothing about the first one going missing.
  it('the collapsed rail offers no Delete control', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.queryByLabelText('Delete page')).not.toBeInTheDocument();
  });

  it('expanded, Delete still drives the move-to-trash dialog', async () => {
    useUiStore.setState({ articleSidebarCollapsed: false });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    // Two steps by design: the disclosure, then the confirm. That first step is
    // exactly what the collapsed rail used to skip. (The expanded control is
    // labelled by its visible text; `aria-label="Delete page"` belonged to the
    // rail icon alone, which is why the check above can look for it.)
    fireEvent.click(screen.getByText('Danger zone'));
    fireEvent.click(screen.getByText('Delete'));

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
