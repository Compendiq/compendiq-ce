import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleRightPane } from './ArticleRightPane';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useUiStore } from '../../../stores/ui-store';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { toast } from 'sonner';

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

const mockVerifyPage = vi.fn();
let mockRelocateAllowed = true;

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const mockPage = {
  id: 'page-1',
  confluenceId: '98765432',
  title: 'Engineering Handbook',
  spaceKey: 'ENG',
  source: 'confluence' as const,
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
  verifiedAt: null as string | null,
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
// RelocateDialog is rendered for real (the pane must hand it the page's own
// `source`); an empty object is a truthy preview and then crashes on
// `accessChange.from`.
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url.includes('usecase-default')) return { provider: 'p1', model: 'bge-x' };
    if (url.includes('/relocate/preview')) {
      return {
        pageId: 1,
        title: 'Engineering Handbook',
        source: 'standalone',
        spaceKey: null,
        confluenceId: null,
        target: 'confluence',
        childCount: 0,
        subtreeEffect: null,
        attachmentCount: 0,
        localVersionCount: 0,
        accessChange: {
          from: 'Private article — only tester can read it',
          to: 'Everyone with access to the chosen Confluence space',
          gains: [],
          loses: [],
          truncated: false,
        },
        upstreamDeletion: null,
      };
    }
    return {};
  }),
}));

vi.mock('../../hooks/use-permission', () => ({
  usePermission: (permission: string) => ({
    allowed: permission === 'pages:relocate' ? mockRelocateAllowed : false,
    loading: false,
    error: null,
  }),
}));

vi.mock('../../hooks/use-spaces', () => ({
  useSpaces: () => ({ data: [{ key: 'DEV', name: 'Developer Docs', source: 'confluence' }] }),
}));

vi.mock('../../hooks/use-standalone', () => ({
  useExportPdf: () => ({ mutateAsync: mockExportPdfAsync, isPending: false }),
  useVerifyPage: () => ({ mutateAsync: mockVerifyPage, isPending: false }),
  useLocalSpaces: () => ({ data: [{ key: 'HOME', name: 'Home', source: 'local' }] }),
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
  EmbeddingStatusBadge: ({
    embeddingStatus,
    onRetry,
  }: {
    embeddingStatus: string;
    onRetry?: () => void;
  }) => (
    <span data-testid="embedding-status-badge">
      {embeddingStatus}
      {onRetry && (
        <button data-testid="mock-embedding-retry-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </span>
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
    mockVerifyPage.mockReset().mockResolvedValue(undefined);
    mockRelocateAllowed = true;
    resyncIsPending = false;
    reembedIsPending = false;
    requalityIsPending = false;
    localStorage.clear();
    useUiStore.setState({
      articleSidebarCollapsed: false,
      articleSidebarLaptopExpanded: false,
      articleSidebarWidth: 280,
    });
    useArticleViewStore.setState({ headings: [], editing: false });
    // The dock forces this pane into its rail while open (#1126), so a test
    // that opens it would otherwise change what every later test renders.
    useAiDockStore.setState({ open: false });
    // jsdom's default. `useIsDockWideLayout` reads it via matchMedia, and the
    // pane steps aside entirely below 1100px while the dock is open.
    window.innerWidth = 1280;
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
    expect(screen.getByText('Page details')).toBeInTheDocument();
    expect(screen.getByText('Move to trash')).toBeInTheDocument();
  });

  it('keeps pin and history visible and tucks export, graph and deletion behind disclosures', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Pin').closest('details')).toBeNull();
    expect(screen.getByText('Version history').closest('details')).toBeNull();

    const moreActions = screen.getByText('More actions').closest('details');
    const dangerZone = screen.getByText('Danger zone').closest('details');
    expect(moreActions).not.toHaveAttribute('open');
    expect(dangerZone).not.toHaveAttribute('open');

    fireEvent.click(screen.getByText('More actions'));
    expect(moreActions).toHaveAttribute('open');
    expect(screen.getByText('Export PDF').closest('details')).toBe(moreActions);
    expect(screen.getByText('Open in Confluence').closest('details')).toBe(moreActions);
    expect(screen.getByText('Show in Graph').closest('details')).toBe(moreActions);
    fireEvent.click(screen.getByText('Danger zone'));
    expect(dangerZone).toHaveAttribute('open');
  });

  it('lists page facts above page actions in Details', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });
    const facts = screen.getByText('Page details');
    const actions = screen.getByText('Page actions');
    expect(facts.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('gives outline expand a 24px out-of-flow hit target', () => {
    useArticleViewStore.setState({
      headings: [
        { id: 'intro', text: 'Introduction', level: 1 },
        { id: 'setup', text: 'Setup', level: 2 },
      ],
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    const expand = screen.getByLabelText('Collapse section');
    expect(expand).toHaveAttribute('aria-hidden', 'true');
    expect(expand).toHaveAttribute('tabIndex', '-1');
    expect(expand.className).toMatch(/\bsize-6\b/);
    expect(expand.className).toMatch(/\babsolute\b/);
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

    fireEvent.click(screen.getByLabelText('Expand inspector'));

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
  });

  it('starts collapsed below xl even when the wide-layout preference is expanded', () => {
    window.innerWidth = 1024;
    useUiStore.setState({
      articleSidebarCollapsed: false,
      articleSidebarLaptopExpanded: false,
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('expands on laptop via the laptop-expanded flag, not the wide persist', () => {
    window.innerWidth = 1024;
    useUiStore.setState({
      articleSidebarCollapsed: true,
      articleSidebarLaptopExpanded: false,
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('Expand inspector'));

    expect(useUiStore.getState().articleSidebarLaptopExpanded).toBe(true);
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

  it('preserves Page details and Document health in edit mode', () => {
    useArticleViewStore.setState({ editing: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Page details')).toBeInTheDocument();
    expect(screen.getByText('ENG')).toBeInTheDocument();
    expect(screen.getByText('v7')).toBeInTheDocument();
    expect(screen.getByText('Document health')).toBeInTheDocument();
    expect(screen.getByTestId('embedding-status-badge')).toBeInTheDocument();
    expect(screen.getByTestId('quality-score-badge')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('renders Version history in the collapsed rail overflow', async () => {
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByTestId('article-actions-rail'));
    expect(await screen.findByTestId('article-history-rail-btn')).toBeInTheDocument();
    expect(screen.getByLabelText('Version history')).toBeInTheDocument();
  });

  it('wires onRetry on EmbeddingStatusBadge to trigger reembed', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });

    const retryBtn = screen.getByTestId('mock-embedding-retry-btn');
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);

    expect(mockReembedPage).toHaveBeenCalledTimes(1);
    expect(mockReembedPage.mock.calls[0]![0]).toBe('page-1');
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
    fireEvent.click(screen.getByLabelText('Expand inspector'));

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

  it('as a sheet stays expanded even when the dock flag is set', () => {
    window.innerWidth = 500;
    useAiDockStore.setState({ open: true });
    useUiStore.setState({ articleSidebarCollapsed: true });

    render(
      <ArticleRightPane presentation="sheet" />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
    expect(screen.queryByTestId('article-right-pane-rail')).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize page sidebar' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Close page inspector')).toBeInTheDocument();
  });

  it('as a sheet closes via the header control instead of collapsing to a rail', () => {
    const onRequestClose = vi.fn();
    render(
      <ArticleRightPane presentation="sheet" onRequestClose={onRequestClose} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByLabelText('Close page inspector'));
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(useUiStore.getState().articleSidebarCollapsed).toBe(false);
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

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('article-actions-rail'));
    fireEvent.click(screen.getByTestId('article-requality-rail-btn'));

    expect(mockRequalityPage).toHaveBeenCalledTimes(1);
    expect(mockRequalityPage.mock.calls[0]![0]).toBe('page-1');
  });

  it('hides the rail overflow while editing, but keeps Assistant and Outline', () => {
    useUiStore.setState({ articleSidebarCollapsed: true });
    useArticleViewStore.setState({
      editing: true,
      headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
    });

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByTestId('article-right-pane-rail')).toBeInTheDocument();
    expect(screen.getByTestId('article-outline-rail-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('article-assistant-rail-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('article-actions-rail')).not.toBeInTheDocument();
  });

  describe('collapsed rail hybrid (primary + overflow)', () => {
    function renderRail() {
      useUiStore.setState({ articleSidebarCollapsed: true });
      return render(<ArticleRightPane />, { wrapper: createWrapper() });
    }

    it('is a complementary landmark named Page inspector', () => {
      renderRail();
      const rail = screen.getByTestId('article-right-pane-rail');
      expect(rail.tagName).toBe('ASIDE');
      expect(rail).toHaveAttribute('aria-label', 'Page inspector');
    });

    it('keeps the collapsed rail focused on its controls without a redundant view label', () => {
      renderRail();
      expect(screen.queryByTestId('inspector-rail-current-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('article-details-rail-btn')).toHaveAccessibleName('Page details');
      expect(screen.getByTestId('article-details-rail-btn').className).toMatch(/nm-pill-active/);
      expect(screen.getByTestId('article-details-rail-btn').className).not.toMatch(/text-action/);
    });

    it('aligns the collapsed rail divider with the expanded toolbar row', () => {
      renderRail();
      const chrome = screen.getByTestId('article-right-pane-rail').querySelector('.h-12');
      expect(chrome).toHaveClass('h-12', 'border-b', 'border-border');
    });

    it('keeps Expand and the current view first-class and parks pin and maintenance behind More', () => {
      renderRail();

      expect(screen.getByLabelText('Expand inspector')).toBeInTheDocument();
      expect(screen.getByTestId('article-details-rail-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('article-assistant-rail-btn')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Pin page')).not.toBeInTheDocument();

      expect(screen.queryByTestId('article-requality-rail-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('article-reembed-rail-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('article-history-rail-btn')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Export PDF')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('article-actions-rail'));

      expect(screen.getByTestId('article-assistant-rail-btn')).toBeInTheDocument();
      expect(screen.getByLabelText('Pin page')).toBeInTheDocument();
      expect(screen.getByTestId('article-requality-rail-btn')).toBeInTheDocument();
      expect(screen.getByTestId('article-reembed-rail-btn')).toBeInTheDocument();
      expect(screen.getByTestId('article-history-rail-btn')).toBeInTheDocument();
      expect(screen.getByLabelText('Export PDF')).toBeInTheDocument();
      expect(screen.getByText('Maintenance & AI')).toBeInTheDocument();
    });

    it('names Re-embed without RAG jargon', async () => {
      renderRail();
      fireEvent.click(screen.getByTestId('article-actions-rail'));

      const reembed = await screen.findByTestId('article-reembed-rail-btn');
      expect(reembed).toHaveAccessibleName(/re-embed for search/i);
      expect(reembed).not.toHaveAccessibleName(/RAG/i);
    });

    it('invokes requality from the overflow, not the open rail', async () => {
      renderRail();
      fireEvent.click(screen.getByTestId('article-actions-rail'));
      fireEvent.click(await screen.findByTestId('article-requality-rail-btn'));

      expect(mockRequalityPage).toHaveBeenCalledTimes(1);
      expect(mockRequalityPage.mock.calls[0]![0]).toBe('page-1');
    });

    it('expands onto the Assistant tab from More', () => {
      renderRail();
      fireEvent.click(screen.getByTestId('article-actions-rail'));
      fireEvent.click(screen.getByTestId('article-assistant-rail-btn'));

      expect(useUiStore.getState().articleSidebarCollapsed).toBe(false);
      expect(screen.getByTestId('page-context-tab-assistant')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('marks Pin as pressed and keeps the shared focus ring', () => {
      renderRail();
      fireEvent.click(screen.getByTestId('article-actions-rail'));
      const pin = screen.getByLabelText('Pin page');
      expect(pin).toHaveAttribute('aria-pressed', 'false');
      expect(pin.className).toMatch(/focus-visible:ring-2/);
    });

    it('paints the rail Assistant mark violet', () => {
      renderRail();
      fireEvent.click(screen.getByTestId('article-actions-rail'));
      const trigger = screen.getByTestId('article-assistant-rail-btn');
      const mark = trigger.querySelector('svg');
      expect(mark).not.toBeNull();
      expect(mark!.className.baseVal || mark!.getAttribute('class') || '').toContain(
        'text-status-ai',
      );
    });

    it('closes the outline flyout when focus leaves it for another rail control', async () => {
      useArticleViewStore.setState({
        headings: [{ id: 'intro', text: 'Introduction', level: 1 }],
      });
      renderRail();

      const outline = screen.getByTestId('article-outline-rail-btn');
      const expand = screen.getByLabelText('Expand inspector');
      fireEvent.focus(outline);
      expect(screen.getByTestId('article-outline-flyout')).toBeInTheDocument();

      fireEvent.blur(outline, { relatedTarget: expand });

      await waitFor(() => {
        expect(screen.queryByTestId('article-outline-flyout')).not.toBeInTheDocument();
      });
    });
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
      expect(screen.queryByText('2 sections')).not.toBeInTheDocument();
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

      expect(trigger).toHaveAttribute('aria-label', 'Outline');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveAttribute('aria-controls', 'article-outline-flyout');

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('article-outline-flyout')).toHaveAttribute('id', 'article-outline-flyout');
      expect(screen.getByTestId('article-outline-flyout')).toHaveTextContent('Same as the Outline tab');
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
    expect(screen.getByRole('tab', { name: 'Outline' })).not.toHaveTextContent('2');
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

    it('manages roving tabindex and arrow-key navigation across visible nodes', () => {
      useArticleViewStore.setState({
        headings: [
          { id: 'intro', text: 'Introduction', level: 1 },
          { id: 'arch', text: 'Architecture', level: 2 },
          { id: 'deploy', text: 'Deployment', level: 1 },
        ],
      });
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      const intro = screen.getByText('Introduction').closest('[role="treeitem"]')!;
      const arch = screen.getByText('Architecture').closest('[role="treeitem"]')!;
      const deploy = screen.getByText('Deployment').closest('[role="treeitem"]')!;

      // Initially, the first visible node is the roving tab stop
      expect(intro.getAttribute('tabindex')).toBe('0');
      expect(arch.getAttribute('tabindex')).toBe('-1');
      expect(deploy.getAttribute('tabindex')).toBe('-1');

      // ArrowDown moves roving tab stop to next node
      fireEvent.keyDown(intro, { key: 'ArrowDown' });
      expect(arch.getAttribute('tabindex')).toBe('0');

      // ArrowDown again moves to Deployment
      fireEvent.keyDown(arch, { key: 'ArrowDown' });
      expect(deploy.getAttribute('tabindex')).toBe('0');

      // ArrowUp moves back to Architecture
      fireEvent.keyDown(deploy, { key: 'ArrowUp' });
      expect(arch.getAttribute('tabindex')).toBe('0');

      // Home moves to first item (Introduction)
      fireEvent.keyDown(arch, { key: 'Home' });
      expect(intro.getAttribute('tabindex')).toBe('0');

      // End moves to last item (Deployment)
      fireEvent.keyDown(intro, { key: 'End' });
      expect(deploy.getAttribute('tabindex')).toBe('0');
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

    it('wraps nested sub-headings in role="group" with correct aria-level and title', () => {
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

      const introRow = screen.getByText('Introduction').closest('[role="treeitem"]')!;
      const usageRow = screen.getByText('Usage').closest('[role="treeitem"]')!;
      expect(introRow).toHaveAttribute('aria-level', '1');
      expect(usageRow).toHaveAttribute('aria-level', '2');
      expect(screen.getByText('Usage')).toHaveAttribute('title', 'Usage');
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
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(handle).toHaveAttribute('aria-valuemin', '300');
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

  it('lists source and draft facts in Details, not as header chrome', () => {
    currentMockPage = {
      ...mockPage,
      source: 'standalone',
      visibility: 'private',
      hasDraft: true,
    } as typeof currentMockPage;

    render(<ArticleRightPane />, { wrapper: createWrapper() });

    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Visibility')).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByText('Unpublished draft')).toBeInTheDocument();
  });

  it('uses confluenceId (not internal id) in the "Open in Confluence" link', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('More actions'));

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

    fireEvent.click(screen.getByText('Move to trash'));

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

    fireEvent.click(screen.getByText('Move to trash'));
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
    fireEvent.click(screen.getByText('Move to trash'));

    expect(await screen.findByText('Move page to trash?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(mockDeletePage).toHaveBeenCalledWith('page-1');
    });
  });

  // --- PDF Export ---
  it('renders the Export PDF button', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('More actions'));

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
    fireEvent.click(screen.getByText('More actions'));
    fireEvent.click(screen.getByText('Export PDF'));

    await waitFor(() => {
      expect(mockExportPdfAsync).toHaveBeenCalledWith(NaN);
    });
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledWith(fakeBlob);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/fake-url');
    });
  });

  it('shows this page in the graph from Details', () => {
    render(<ArticleRightPane />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('More actions'));

    fireEvent.click(screen.getByTestId('show-in-graph-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('/graph?focus=page-1');
  });

  describe('relocate entry point (#1123)', () => {
    it('offers "Move to Confluence" on a local article', () => {
      currentMockPage = {
        ...mockPage,
        source: 'standalone',
        spaceKey: 'HOME',
        confluenceId: null,
      };
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.getByTestId('relocate-btn')).toHaveTextContent(/Move to Confluence/i);
    });

    it('offers "Move to a local space" on a Confluence article', () => {
      currentMockPage = { ...mockPage, source: 'confluence' };
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.getByTestId('relocate-btn')).toHaveTextContent(/Move to a local space/i);
    });

    // Hidden, not disabled: `pages:relocate` is seeded onto editor /
    // space_admin by migration 086 and CE ships no UI for granting
    // permissions, so a denied user has no in-product path to earning it.
    it('renders no relocate control without the pages:relocate permission', () => {
      mockRelocateAllowed = false;
      currentMockPage = { ...mockPage, source: 'standalone' };
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.queryByTestId('relocate-btn')).not.toBeInTheDocument();
    });

    it('opens the relocate dialog carrying the article’s own source', async () => {
      currentMockPage = { ...mockPage, source: 'standalone', confluenceId: null };
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('relocate-btn'));

      await screen.findByRole('dialog');
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toHaveTextContent(/move to confluence/i);
      });

      fireEvent.click(screen.getByTestId('relocate-cancel'));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('hides the relocate control while the editor is open', () => {
      currentMockPage = { ...mockPage, source: 'standalone' };
      useArticleViewStore.setState({ editing: true });
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.queryByTestId('relocate-btn')).not.toBeInTheDocument();
    });
  });

  describe('verification', () => {
    it('shows Not verified until a stamp exists, then records one', async () => {
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      expect(screen.getByTestId('verification-chip')).toHaveTextContent('Not verified');
      const verifyBtn = screen.getByTestId('verify-btn');
      expect(verifyBtn).toHaveAttribute('aria-busy', 'false');
      expect(verifyBtn).toHaveTextContent('Record verification');

      fireEvent.click(verifyBtn);

      await waitFor(() => {
        expect(mockVerifyPage).toHaveBeenCalledWith({ pageId: NaN });
      });
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Page verified — next review reminder rescheduled');
      });
    });

    it('renders the last verification date on the chip', () => {
      currentMockPage = { ...mockPage, verifiedAt: '2026-03-01T12:00:00Z' };
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      const expected = new Date('2026-03-01T12:00:00Z').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      expect(screen.getByTestId('verification-chip')).toHaveTextContent(`Verified ${expected}`);
    });
  });

  describe('inspector tabs and staging retention', () => {
    it('sets roving tabIndex on inspector tab buttons (0 on active, -1 on inactive)', () => {
      useArticleViewStore.setState({
        headings: [{ id: 'h1', text: 'Section 1', level: 1 }],
      });
      render(<ArticleRightPane />, { wrapper: createWrapper() });

      const assistantTab = screen.getByTestId('page-context-tab-assistant');
      const outlineTab = screen.getByTestId('page-context-tab-outline');
      const detailsTab = screen.getByTestId('page-context-tab-details');

      expect(outlineTab).toHaveAttribute('tabIndex', '0');
      expect(assistantTab).toHaveAttribute('tabIndex', '-1');
      expect(detailsTab).toHaveAttribute('tabIndex', '-1');

      fireEvent.click(assistantTab);

      expect(assistantTab).toHaveAttribute('tabIndex', '0');
      expect(outlineTab).toHaveAttribute('tabIndex', '-1');
      expect(detailsTab).toHaveAttribute('tabIndex', '-1');
    });

    it('retains the mounted assistant panel with hidden class when switching tabs to preserve staged state', () => {
      useArticleViewStore.setState({
        headings: [{ id: 'h1', text: 'Section 1', level: 1 }],
      });
      const { container } = render(<ArticleRightPane />, { wrapper: createWrapper() });

      // Initially outline is active, assistant panel is not yet mounted
      expect(container.querySelector('#page-context-panel-assistant')).toBeNull();

      // Switch to assistant tab
      fireEvent.click(screen.getByTestId('page-context-tab-assistant'));
      const panel = container.querySelector('#page-context-panel-assistant');
      expect(panel).not.toBeNull();
      expect(panel?.classList.contains('hidden')).toBe(false);

      // Switch back to outline tab
      fireEvent.click(screen.getByTestId('page-context-tab-outline'));
      // Panel remains in DOM but is hidden via CSS to preserve state
      expect(container.querySelector('#page-context-panel-assistant')).not.toBeNull();
      expect(container.querySelector('#page-context-panel-assistant')?.classList.contains('hidden')).toBe(true);
    });

    it('renders and supports tab switching on /pages/new create route', () => {
      useArticleViewStore.setState({
        headings: [],
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const router = createMemoryRouter(
        [{ path: '/pages/new', element: <ArticleRightPane /> }],
        { initialEntries: ['/pages/new'] },
      );

      render(
        <QueryClientProvider client={queryClient}>
          <LazyMotion features={domAnimation}>
            <RouterProvider router={router} />
          </LazyMotion>
        </QueryClientProvider>,
      );

      // On /pages/new with no headings, defaults to Assistant tab
      expect(screen.getByRole('tab', { name: 'Assistant' })).toHaveAttribute('aria-selected', 'true');

      // Click Details tab
      fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
      expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('New page draft')).toBeInTheDocument();

      // Click Outline tab
      fireEvent.click(screen.getByRole('tab', { name: /Outline/ }));
      expect(screen.getByRole('tab', { name: /Outline/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('No outline yet')).toBeInTheDocument();
    });
  });
});
