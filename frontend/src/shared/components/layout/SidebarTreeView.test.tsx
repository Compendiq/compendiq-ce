import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarTreeView, SidebarTreeNode } from './SidebarTreeView';
import type { TreeNode, SidebarTreeNodeProps } from './SidebarTreeView';
import { useUiStore } from '../../../stores/ui-store';
import { ApiError } from '../../lib/api';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual('framer-motion');
  return { ...actual, useReducedMotion: () => true };
});

// DndLocalSpaceTree is lazy-loaded; provide a lightweight stub so Suspense
// resolves synchronously in tests without pulling in @dnd-kit. The stub mirrors
// the real component's `data-active` marker on the active row (#707) so the
// parent's scroll-into-view effect can find it end-to-end for local spaces.
vi.mock('./DndLocalSpaceTree', () => ({
  default: ({ activePageId }: { activePageId?: string }) => (
    <div data-testid="dnd-local-space-tree">
      {activePageId && <div data-active="true" data-page-id={activePageId} />}
    </div>
  ),
}));

const mockNavigate = vi.fn();
// #960: count how often a tree row consuming useNavigate renders. Each row
// calls useNavigate() exactly once per render (before and after the fix), so
// this spy is a reliable render counter — React's <Profiler> onRender proved
// unreliable for context-driven re-renders under jsdom.
const mockUseNavigate = vi.fn(() => mockNavigate);
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockUseNavigate(),
  };
});

const defaultTreeData = {
  items: [
    { id: 'root-1', spaceKey: 'DEV', title: 'Getting Started', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'child-1', spaceKey: 'DEV', title: 'Installation', pageType: 'page' as const, parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'child-2', spaceKey: 'DEV', title: 'Configuration', pageType: 'page' as const, parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'root-2', spaceKey: 'DEV', title: 'API Reference', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
  ],
  total: 4,
};

let mockTreeData: typeof defaultTreeData | undefined = { ...defaultTreeData };

// Query/mutation state the error tests drive. Kept as mutable objects rather
// than per-test vi.mock factories so a test only has to state the one field it
// cares about; `resetQueryState()` in beforeEach puts them back.
const mockRefetchTree = vi.fn();
const mockCreatePageReset = vi.fn();
let mockTreeQueryState = { isLoading: false, isError: false, error: undefined as unknown, isFetching: false };
let mockCreatePageState = { isPending: false, isError: false, error: undefined as unknown };

function resetQueryState() {
  mockTreeQueryState = { isLoading: false, isError: false, error: undefined, isFetching: false };
  mockCreatePageState = { isPending: false, isError: false, error: undefined };
  mockRefetchTree.mockClear();
  mockCreatePageReset.mockClear();
}
let mockPinnedData = { items: [] as Array<{
  id: string;
  spaceKey: string;
  title: string;
  author: string | null;
  lastModifiedAt: string | null;
  excerpt: string;
  pinnedAt: string;
  pinOrder: number;
}>, total: 0 };

const mockSpaces = [
  { key: 'DEV', name: 'Development', homepageId: 'root-1', lastSynced: '2026-03-01T00:00:00Z', pageCount: 4, source: 'confluence' as const },
  { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 2, source: 'confluence' as const },
];

const defaultLocalSpaces = [
  { key: 'NOTES', name: 'My Notes', description: null, icon: null as string | null, pageCount: 3, createdBy: null, createdAt: '2026-03-01T00:00:00Z', source: 'local' as const },
];
let mockLocalSpaces = [...defaultLocalSpaces];

const mockCreatePageMutateAsync = vi.fn();
vi.mock('../../hooks/use-pages', () => ({
  usePageTree: () => ({
    data: mockTreeData,
    refetch: mockRefetchTree,
    ...mockTreeQueryState,
  }),
  useCreatePage: () => ({
    mutateAsync: mockCreatePageMutateAsync,
    reset: mockCreatePageReset,
    ...mockCreatePageState,
  }),
  usePinnedPages: () => ({ data: mockPinnedData }),
}));

vi.mock('../../hooks/use-spaces', () => ({
  useSpaces: () => ({ data: mockSpaces }),
}));

vi.mock('../../hooks/use-standalone', () => ({
  useLocalSpaces: () => ({ data: mockLocalSpaces }),
  useReorderPage: () => ({ mutate: vi.fn() }),
}));

function createWrapper(initialPath = '/pages') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('SidebarTreeView', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTreeData = { ...defaultTreeData };
    mockPinnedData = { items: [], total: 0 };
    mockLocalSpaces = [...defaultLocalSpaces];
    resetQueryState();
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
      treeSidebarWidth: 256,
    });
  });

  it('renders nav tabs (Pages, AI, Graph) at the top of the sidebar', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pages/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Graph/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /AI/ })).toBeInTheDocument();
  });

  // The main nav is a segmented control, the same shape as the article
  // inspector's Outline/Details tabs and the search-mode toggle. It used
  // `nav-selection` (an accent-tinted field), which was a fourth treatment for
  // "one of N is selected"; the raised neutral segment is the shared one.
  // `bg-action` stays asserted-against: a near-black fill would make the nav
  // the heaviest thing in the rail.
  it('active nav tab uses the shared segmented-control treatment', () => {
    // location.pathname === '/' => Pages tab is active.
    render(<SidebarTreeView />, { wrapper: createWrapper('/') });
    const pagesLink = screen.getByRole('link', { name: /Pages/ });
    expect(pagesLink.className).toContain('nm-pill-active');
    expect(pagesLink.className).not.toContain('bg-action');
  });

  it('active AI tab keeps its icon in the selection ink', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai') });
    const aiLink = screen.getByRole('link', { name: /AI/ });
    const selectedIcon = aiLink.querySelector('[class*="text-primary-ink"]');
    expect(selectedIcon).not.toBeNull();
  });

  it('inactive AI tab icon does not use amber (would fail 3:1 against light glass)', () => {
    // Render with location.pathname === '/' so Pages is active, AI is inactive.
    render(<SidebarTreeView />, { wrapper: createWrapper('/') });
    const aiLink = screen.getByRole('link', { name: /AI/ });
    // No descendant of the inactive AI link may carry text-primary — otherwise
    // amber would sit on the light glass pill (~1.47:1 contrast, WCAG failure).
    const amberDescendant = aiLink.querySelector('[class*="text-primary"]');
    expect(amberDescendant).toBeNull();
  });

  it('renders "Pages" label in sidebar header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getAllByText('Pages').length).toBeGreaterThanOrEqual(1);
  });

  it('renders root pages', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
  });

  it('orders sibling roots by sortOrder, not alphabetically (#959)', () => {
    // "Zebra" is stored before "Alpha" (drag-reorder), so honouring sortOrder
    // must beat the title tiebreak — otherwise a drop snaps back to A→Z.
    mockTreeData = {
      items: [
        { id: 'p-alpha', spaceKey: 'DEV', title: 'Alpha', pageType: 'page' as const, parentId: null, sortOrder: 2, labels: [], lastModifiedAt: null, embeddingDirty: false },
        { id: 'p-zebra', spaceKey: 'DEV', title: 'Zebra', pageType: 'page' as const, parentId: null, sortOrder: 1, labels: [], lastModifiedAt: null, embeddingDirty: false },
      ],
      total: 2,
    };
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const titles = screen.getAllByRole('treeitem').map((el) => el.textContent);
    expect(titles).toEqual(['Zebra', 'Alpha']);
  });

  it('children are hidden by default', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();
  });

  it('expands node on chevron click to reveal children', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    fireEvent.click(expandBtn);
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('keeps the sidebar scroll position when a node is expanded (does not jump to the active page)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const scroller = screen.getByTestId('tree-scroll');
    // The user has scrolled the tree down before interacting.
    scroller.scrollTop = 120;
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    // mousedown must snapshot the position *before* the browser scrolls the
    // freshly-focused chevron into view…
    fireEvent.mouseDown(expandBtn);
    // …which we emulate here by jumping the list to the top (the active page).
    scroller.scrollTop = 0;
    // Expanding the node must restore the pre-click position, not stay jumped.
    fireEvent.click(expandBtn);
    expect(scroller.scrollTop).toBe(120);
    // Sanity: the node still actually expanded.
    expect(screen.getByText('Installation')).toBeInTheDocument();
  });

  it('keeps the sidebar scroll position when a node is collapsed (snapshot is re-captured per press)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const scroller = screen.getByTestId('tree-scroll');
    // Expand first so the node exposes a "Collapse" chevron.
    fireEvent.click(screen.getAllByLabelText('Expand')[0]);
    expect(screen.getByText('Installation')).toBeInTheDocument();
    // A *different* position than the expand test — proves the snapshot is taken
    // fresh on this press, not reused from an earlier interaction.
    scroller.scrollTop = 90;
    const collapseBtn = screen.getByLabelText('Collapse'); // the chevron, not the "Collapse <title>" indent guide
    fireEvent.mouseDown(collapseBtn);
    scroller.scrollTop = 0; // emulate the browser's focus-into-view jump
    fireEvent.click(collapseBtn);
    expect(scroller.scrollTop).toBe(90);
    // Sanity: the node actually collapsed.
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();
  });

  it('does not restore scroll on auto-expand (navigation); only a node press restores', () => {
    // OPS has no homepage, so the full tree (incl. root-1 + its children) renders;
    // setting it explicitly also stops the auto-select-space effect from switching
    // to DEV (whose homepage root-1 would be hidden).
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: 'OPS' });
    const { rerender } = render(<SidebarTreeView />, { wrapper: createWrapper('/pages/child-1') });
    const scroller = screen.getByTestId('tree-scroll');
    // Viewing child-1 auto-expands its ancestor root-1 on mount — no press involved.
    expect(screen.getByText('Installation')).toBeInTheDocument();

    // Leave a non-null snapshot behind via a real press (collapse root-1).
    scroller.scrollTop = 200;
    const collapseBtn = screen.getByLabelText('Collapse');
    fireEvent.mouseDown(collapseBtn);
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();

    // User scrolls; then an auto-expand fires WITHOUT a press — emulated by new
    // tree data, which re-runs the ancestor auto-expand effect.
    scroller.scrollTop = 50;
    mockTreeData = { ...defaultTreeData, items: [...defaultTreeData.items] };
    rerender(<SidebarTreeView />);

    // The ancestor re-expanded, but the guard left scroll where the user put it —
    // it was NOT yanked back to the stale 200 snapshot.
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(50);
  });

  it('shows indent guide line when a folder is expanded', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    fireEvent.click(expandBtn);
    expect(screen.getByLabelText('Collapse Getting Started')).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse Getting Started')).toHaveClass('indent-guide');
  });

  it('collapses folder when indent guide line is clicked', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    fireEvent.click(expandBtn);
    expect(screen.getByText('Installation')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Collapse Getting Started'));
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();
  });

  it('positions indent guide at correct depth for nested levels', () => {
    // #352: pick a space without a homepage so the tree shows all roots.
    // (With a homepage set the homepage is now hidden — see the dedicated
    // #352 test below.) Manually expand "Getting Started" by clicking the
    // chevron (aria-label="Expand") to surface the collapse-affordance
    // whose left offset we're asserting.
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'OPS', // OPS has no homepage; tree shows all roots
    });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Only one root has children (Getting Started → Installation+Configuration)
    // so there's exactly one "Expand" chevron at this point.
    fireEvent.click(screen.getByLabelText('Expand'));
    const guide = screen.getByLabelText('Collapse Getting Started');
    // level=0 => left = 0*12+8 = 8px. `.indent-guide` is a 12px-wide click
    // target with its visible 1px line centred, so this lands the line on the
    // parent chevron's axis (0*12+2 + 24/2 = 14).
    expect(guide.style.left).toBe('8px');
  });

  it('navigates to page on click', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('API Reference'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/root-2');
  });

  it('navigates to /ai?pageId= on click when on AI route (#417)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai') });
    fireEvent.click(screen.getByText('API Reference'));
    expect(mockNavigate).toHaveBeenCalledWith('/ai?pageId=root-2', { replace: true });
  });

  it('highlights the article matching ?pageId on the AI route (#417)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai?pageId=child-1') });
    const installRef = screen.getByText('Installation');
    const row = installRef.parentElement!;
    expect(row.className).toContain('nav-selection');
  });

  // #767: tree titles intermittently rendered faux-bold (synthesized weight
  // during variable-font load / compositing re-rasterization). The weight is
  // now pinned per-state on the title span so it can never float: exactly one
  // of font-normal / font-medium, never both (Tailwind class order between the
  // two utilities is unspecified, so conditional classes are mandatory).
  it('pins font-normal on inactive tree titles and font-medium on the active title (#767)', () => {
    // OPS has no homepage, so the full tree (incl. "Getting Started") renders.
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: 'OPS' });
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/root-2') });

    const activeTitle = screen.getByText('API Reference');
    expect(activeTitle.className).toContain('font-medium');
    expect(activeTitle.className).not.toContain('font-normal');

    const inactiveTitle = screen.getByText('Getting Started');
    expect(inactiveTitle.className).toContain('font-normal');
    expect(inactiveTitle.className).not.toContain('font-medium');
  });

  it('pins font-normal on every title when no page is active (#767)', () => {
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: 'OPS' });
    render(<SidebarTreeView />, { wrapper: createWrapper('/') });

    for (const title of ['Getting Started', 'API Reference']) {
      const span = screen.getByText(title);
      expect(span.className).toContain('font-normal');
      expect(span.className).not.toContain('font-medium');
    }
  });

  it('shows collapsed state with expand toggle and nav icons when treeSidebarCollapsed is true', () => {
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument();
    expect(screen.getByLabelText('Pages')).toBeInTheDocument();
    expect(screen.getByLabelText('Graph')).toBeInTheDocument();
    expect(screen.getByLabelText('AI')).toBeInTheDocument();
  });

  it('expands sidebar when collapsed expand button is clicked', () => {
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('Expand sidebar'));
    expect(useUiStore.getState().treeSidebarCollapsed).toBe(false);
  });

  it('shows space selector with All Spaces default', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('All Spaces')).toBeInTheDocument();
  });

  it('shows page count in footer', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('4 pages')).toBeInTheDocument();
  });

  it('opens space dropdown and shows confluence and local space options', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('My Notes')).toBeInTheDocument();
  });

  it('shows grouped space headers in dropdown', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Confluence')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  it('shows "New Space" button in dropdown', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('New Space')).toBeInTheDocument();
  });

  it('closes space dropdown on outside click', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Development')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Development')).not.toBeInTheDocument();
  });

  it('closes space dropdown on Escape key', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Development')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Development')).not.toBeInTheDocument();
  });

  it('renders resize handle', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const handle = screen.getByRole('separator', { name: 'Resize tree sidebar' });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('applies persisted width from store', () => {
    useUiStore.setState({ treeSidebarWidth: 320 });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const aside = screen.getByRole('separator', { name: 'Resize tree sidebar' }).parentElement!;
    expect(aside.style.width).toBe('320px');
  });

  it('starts resizing on mousedown and updates width on mousemove', () => {
    useUiStore.setState({ treeSidebarWidth: 256 });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const handle = screen.getByRole('separator', { name: 'Resize tree sidebar' });

    fireEvent.mouseDown(handle, { clientX: 256 });
    fireEvent.mouseMove(document, { clientX: 356 });
    fireEvent.mouseUp(document);

    expect(useUiStore.getState().treeSidebarWidth).toBe(356);
  });

  it('clamps width to minimum of 180px', () => {
    useUiStore.setState({ treeSidebarWidth: 256 });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const handle = screen.getByRole('separator', { name: 'Resize tree sidebar' });

    fireEvent.mouseDown(handle, { clientX: 256 });
    fireEvent.mouseMove(document, { clientX: 50 });
    fireEvent.mouseUp(document);

    expect(useUiStore.getState().treeSidebarWidth).toBe(180);
  });

  it('clamps width to maximum of 600px', () => {
    useUiStore.setState({ treeSidebarWidth: 256 });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const handle = screen.getByRole('separator', { name: 'Resize tree sidebar' });

    fireEvent.mouseDown(handle, { clientX: 256 });
    fireEvent.mouseMove(document, { clientX: 700 });
    fireEvent.mouseUp(document);

    expect(useUiStore.getState().treeSidebarWidth).toBe(600);
  });

  it('supports keyboard resizing and double-click reset', () => {
    useUiStore.setState({ treeSidebarWidth: 320 });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const handle = screen.getByRole('separator', { name: 'Resize tree sidebar' });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(336);

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(320);

    fireEvent.doubleClick(handle);
    // Resets to the default width, which is 280 — see ui-store for why it is
    // no longer 256. Home does the same thing from the keyboard.
    expect(useUiStore.getState().treeSidebarWidth).toBe(280);

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(280);
  });

  it('does not render resize handle when collapsed', () => {
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.queryByRole('separator', { name: 'Resize tree sidebar' })).not.toBeInTheDocument();
  });

  it('lets users override an ephemeral forced collapse without changing their saved preference', () => {
    const onForceExpand = vi.fn();
    render(
      <SidebarTreeView forceCollapsed onForceExpand={onForceExpand} />,
      { wrapper: createWrapper() },
    );

    expect(screen.queryByRole('separator', { name: 'Resize tree sidebar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Expand sidebar'));
    expect(onForceExpand).toHaveBeenCalledOnce();
    expect(useUiStore.getState().treeSidebarCollapsed).toBe(false);
  });

  it('renders up to four compact pinned shortcuts and links overflow to the Pages overview', () => {
    mockPinnedData = {
      total: 5,
      items: Array.from({ length: 5 }, (_, index) => ({
        id: `pin-${index + 1}`,
        spaceKey: 'DEV',
        title: `Pinned page ${index + 1}`,
        author: null,
        lastModifiedAt: null,
        excerpt: '',
        pinnedAt: '2026-03-01T00:00:00Z',
        pinOrder: index + 1,
      })),
    };

    render(<SidebarTreeView />, { wrapper: createWrapper() });

    expect(screen.getByTestId('sidebar-pinned-pin-1')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-pinned-pin-4')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-pinned-pin-5')).not.toBeInTheDocument();
    expect(screen.getByText('View all 5 pinned pages')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-pinned-pin-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/pin-1');
  });

  // A pinned page and a tree page are the same object listed twice in one
  // panel. They used to be 32px/8px-corner/12px and 28px/6px/13px respectively
  // — two row shapes four pixels apart, which reads as a rendering fault rather
  // than a distinction. The Pin glyph is the distinction and it is enough.
  it('gives pinned shortcuts the same row geometry as tree rows', () => {
    mockPinnedData = {
      total: 1,
      items: [{
        id: 'pin-1',
        spaceKey: 'DEV',
        title: 'Pinned page 1',
        author: null,
        lastModifiedAt: null,
        excerpt: '',
        pinnedAt: '2026-03-01T00:00:00Z',
        pinOrder: 1,
      }],
    };

    const { container } = render(<SidebarTreeView />, { wrapper: createWrapper() });

    const pinnedRow = screen.getByTestId('sidebar-pinned-pin-1');
    const treeRow = container.querySelector<HTMLElement>('[data-page-id]')!;

    for (const geometry of ['h-7', 'rounded-md', 'text-[13px]']) {
      expect(pinnedRow.className).toContain(geometry);
      expect(treeRow.className).toContain(geometry);
    }
    // The pair they used to differ by.
    expect(pinnedRow.className).not.toContain('h-8');
    expect(pinnedRow.className).not.toContain('rounded-lg');
  });

  // Was "uses document icons for all pages, including parents with children
  // (no folder icons)". The intent was that a parent page is still a PAGE in
  // Compendiq — there is no folder entity — so it must not wear a folder glyph.
  // That intent now holds more strongly: tree rows carry no page icon at all,
  // because one identical glyph on 100% of rows discriminated nothing and cost
  // 21px of the title's width. The folder assertion stays so the weaker version
  // can't come back by the side door.
  it('gives tree rows no page icon, and never a folder/document distinction', () => {
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'DEV',
    });
    const { container } = render(<SidebarTreeView />, { wrapper: createWrapper() });

    for (const row of container.querySelectorAll('[data-page-id]')) {
      expect(row.querySelectorAll('svg')).toHaveLength(row.querySelector('[aria-label="Expand"], [aria-label="Collapse"]') ? 1 : 0);
    }

    const svgClasses = Array.from(container.querySelectorAll('svg')).map((svg) => svg.getAttribute('class') ?? '');
    const hasFolderIcon = svgClasses.some(
      (c) => c.includes('lucide-folder-open') || (c.includes('lucide-folder') && !c.includes('lucide-folder-plus')),
    );
    expect(hasFolderIcon).toBe(false);
  });

  it('hides the homepage from the tree but promotes its children + other roots (#352)', () => {
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'DEV',
    });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // The homepage itself is hidden — the user reaches it via the dedicated
    // space "Home" link, not by clicking a tree entry.
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument();
    // Its children are promoted to top-level roots so they remain navigable.
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    // Other roots (siblings of the homepage) stay visible.
    expect(screen.getByText('API Reference')).toBeInTheDocument();
  });

  it('keeps the homepage visible when it is the only page in the space (#961)', () => {
    mockTreeData = {
      items: [
        { id: 'root-1', spaceKey: 'DEV', title: 'Getting Started', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
      ],
      total: 1,
    };
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'DEV',
    });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Hiding the homepage would leave the tree empty, so it stays visible and
    // navigable instead of rendering a false "empty space" state.
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.queryByText('No pages in this space')).not.toBeInTheDocument();
    expect(screen.queryByText('This space has no content.')).not.toBeInTheDocument();
  });

  // The space selector used to sit under a "Workspace" caption with a `+`
  // beside it — 101px of panel height to introduce one control, on the panel
  // whose scarcest resource is height. Both are gone. These two tests replace
  // the pair that pinned the header `+`: creating a space is unchanged as a
  // capability, it just lives only where it belongs now.
  it('reaches new-space creation from the selector dropdown, not a header button', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // No second entrance above the selector.
    expect(screen.queryByLabelText('New Space')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('All Spaces'));
    fireEvent.click(screen.getByText('New Space'));
    expect(mockNavigate).toHaveBeenCalledWith('/spaces/new');
  });

  // The caption said "Workspace" while the control selects a SPACE — the noun
  // the API, the dropdown's own Confluence/Local headings and Confluence itself
  // all use. It should not come back under either name: the selector states its
  // own scope on two lines, which is all a caption could have said.
  it('renders no caption above the space selector', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument();
    // The selector itself still names the current scope.
    expect(screen.getByTestId('space-selector-toggle')).toHaveTextContent('All Spaces');
  });

  it('shows collapse sidebar button in expanded sidebar header', () => {
    useUiStore.setState({ treeSidebarCollapsed: false });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByLabelText('Collapse sidebar')).toBeInTheDocument();
  });

  it('collapses sidebar when collapse button is clicked in expanded state', () => {
    useUiStore.setState({ treeSidebarCollapsed: false });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    expect(useUiStore.getState().treeSidebarCollapsed).toBe(true);
  });
});

// #880: tree rows were clickable <div>s with focus-visible classes but no
// tabIndex/role/onKeyDown, so keyboard-only and screen-reader users could not
// focus or activate any page title — a WCAG 2.1.1 (Keyboard) failure on the
// app's primary navigation. Each row is now a focusable role="treeitem" that
// activates navigation on Enter/Space.
describe('SidebarTreeView keyboard navigation (#880)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTreeData = { ...defaultTreeData };
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
    });
  });

  it('exposes each row as a focusable treeitem (role + tabIndex 0)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const row = screen.getByText('API Reference').closest('[role="treeitem"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('tabindex')).toBe('0');
  });

  it('navigates on Enter', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const row = screen.getByText('API Reference').closest('[role="treeitem"]')!;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/pages/root-2');
  });

  it('navigates on Space and prevents the default page-scroll', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const row = screen.getByText('API Reference').closest('[role="treeitem"]')!;
    // fireEvent returns false when the handler called preventDefault().
    const notPrevented = fireEvent.keyDown(row, { key: ' ' });
    expect(notPrevented).toBe(false);
    expect(mockNavigate).toHaveBeenCalledWith('/pages/root-2');
  });

  it('exposes aria-expanded on an expandable row and omits it on a leaf', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const expandable = screen.getByText('Getting Started').closest('[role="treeitem"]')!;
    expect(expandable.getAttribute('aria-expanded')).toBe('false');
    const leaf = screen.getByText('API Reference').closest('[role="treeitem"]')!;
    expect(leaf.getAttribute('aria-expanded')).toBeNull();
  });

  it('ignores keydown bubbling up from the nested chevron button (no double-activation)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const chevron = screen.getAllByLabelText('Expand')[0]!;
    // Enter dispatched on the chevron bubbles to the row; the target guard must
    // stop the row handler from also navigating.
    fireEvent.keyDown(chevron, { key: 'Enter' });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// #856: closes out the roving-tabindex/arrow-key-nav follow-up #880 left
// open — reaching a page used to cost one Tab press per visible row. The
// underlying flatten/keyboard logic (sidebar-tree-keyboard.ts) has its own
// unit tests; these confirm SidebarTreeView actually wires the hook up.
describe('SidebarTreeView roving tabindex (#856)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTreeData = { ...defaultTreeData };
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
    });
  });

  it('defaults the tab stop to the open page, not just the first row', () => {
    // child-1 "Installation", not "Getting Started": root-1 is DEV's
    // configured homepage (see mockSpaces above), so opening any DEV page
    // auto-selects the space and the #352 homepage-hiding rule promotes
    // root-1's children to the top level instead of rendering root-1 itself.
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/child-1') });
    const active = screen.getByText('Installation').closest('[role="treeitem"]')!;
    const other = screen.getByText('API Reference').closest('[role="treeitem"]')!;
    expect(active.getAttribute('tabindex')).toBe('0');
    expect(other.getAttribute('tabindex')).toBe('-1');
  });

  it('moves the tab stop with ArrowDown/ArrowUp and gives the row real DOM focus', () => {
    // No :id in the path -> activePageId stays undefined -> the DEV space
    // is never auto-selected -> root-1 "Getting Started" renders normally
    // alongside root-2 "API Reference" (see the homepage note above).
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // root-2 "API Reference" sorts before root-1 "Getting Started", so it is
    // the initial roving target here.
    const first = screen.getByText('API Reference').closest('[role="treeitem"]')!;
    fireEvent.keyDown(first, { key: 'ArrowDown' });

    const second = screen.getByText('Getting Started').closest('[role="treeitem"]')!;
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(second);
  });

  it('does not move focus off a leaf row on ArrowRight (no children to expand into)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/root-2') });
    const leaf = screen.getByText('API Reference').closest('[role="treeitem"]')!;
    fireEvent.keyDown(leaf, { key: 'ArrowRight' });
    expect(leaf.getAttribute('tabindex')).toBe('0');
  });
});

// #880 (code-review follow-up): the rows carry role="treeitem" but had no
// ancestor role="tree" and nested-children wrappers had no role="group", so
// every treeitem was orphaned — an axe-critical aria-required-parent violation
// that breaks screen-reader tree semantics. The row list is now a role="tree"
// and each expanded node's children live in a role="group".
describe('SidebarTreeView ARIA tree semantics (#880)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTreeData = { ...defaultTreeData };
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
    });
  });

  it('exposes the row list as a labelled ARIA tree (valid required-parent for treeitems)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const tree = screen.getByRole('tree');
    expect(tree).toBeInTheDocument();
    expect(tree.getAttribute('aria-label')).toBeTruthy();
  });

  it('wraps an expanded node\'s children in role="group" so nested treeitems have a valid parent', () => {
    // OPS has no homepage, so the full tree renders and "Getting Started" keeps
    // its children (Installation/Configuration) as a nested, expandable branch.
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: 'OPS' });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('Expand'));
    expect(screen.getByText('Installation')).toBeInTheDocument();
    const group = document.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    // The nested treeitem lives inside the group.
    expect(group!.querySelector('[role="treeitem"]')).not.toBeNull();
  });
});

// #707: on reload the tree mounts scrolled to the top; the active page's path
// is auto-expanded but the row is out of view. The scroll container should
// scroll the active node into view — unless it is already visible (so manual
// scrolling and in-session navigation aren't disrupted).
describe('SidebarTreeView active-page scroll-into-view (#707)', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let rectByTestState: { containerTop: number; containerBottom: number; activeTop: number; activeBottom: number };

  beforeEach(() => {
    mockNavigate.mockClear();
    mockTreeData = { ...defaultTreeData };
    useUiStore.setState({
      treeSidebarCollapsed: false,
      // "All Spaces" so the homepage isn't hidden and the full tree renders.
      treeSidebarSpaceKey: undefined,
    });

    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // jsdom returns zeroed rects, which would read as "always visible". Drive
    // the visibility check from rectByTestState so each test controls geometry.
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 0, activeBottom: 40 };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const isContainer = this.classList.contains('overflow-y-auto');
      const isActive = this.getAttribute('data-active') === 'true';
      if (isContainer) {
        return { top: rectByTestState.containerTop, bottom: rectByTestState.containerBottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      if (isActive) {
        return { top: rectByTestState.activeTop, bottom: rectByTestState.activeBottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  });

  it('scrolls the active node into view on mount when it is below the viewport', () => {
    // Active row sits below the container's bottom edge → off-screen.
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 900, activeBottom: 940 };
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/child-1') });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
  });

  it('uses instant scroll (behavior "auto") when prefers-reduced-motion is set', () => {
    // The file-level framer-motion mock forces useReducedMotion() === true.
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 900, activeBottom: 940 };
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/child-1') });

    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('does not scroll when the active node is already within the viewport', () => {
    // Active row fully inside the container bounds → already visible.
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 100, activeBottom: 140 };
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/child-1') });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not scroll when no page is active', () => {
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 900, activeBottom: 940 };
    render(<SidebarTreeView />, { wrapper: createWrapper('/') });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls the active node into view for a local space (DndLocalSpaceTree) when off-screen', async () => {
    // Select a local space so the lazy DndLocalSpaceTree branch renders. Its
    // stub mirrors the real component's data-active marker, so this exercises
    // the scroll-into-view wiring end-to-end for local spaces. The local tree
    // is lazy-loaded, so the active row appears after the effect's first pass —
    // the MutationObserver fallback catches it once it commits.
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: 'NOTES' });
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 900, activeBottom: 940 };
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/p-local') });

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    });
  });

  it('does NOT scroll the active row into view when the user manually expands a node', () => {
    // Integration with the manual-expand fix: #707 scrolls to the active row on
    // navigation/reload, but a user pressing a chevron must not trigger it —
    // otherwise opening any node jumps the list to the current article.
    // root-3 is a second expandable node (unrelated to the active page); OPS has
    // no homepage so the full tree renders.
    mockTreeData = {
      items: [
        ...defaultTreeData.items,
        { id: 'root-3', spaceKey: 'DEV', title: 'Guides', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
        { id: 'child-3', spaceKey: 'DEV', title: 'Quickstart', pageType: 'page' as const, parentId: 'root-3', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
      ],
      total: 6,
    };
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: 'OPS' });
    // Active row off-screen, so #707 *would* scroll to it on a non-press change.
    rectByTestState = { containerTop: 0, containerBottom: 500, activeTop: 900, activeBottom: 940 };
    render(<SidebarTreeView />, { wrapper: createWrapper('/pages/child-1') });
    scrollIntoView.mockClear(); // ignore the legitimate scroll-to-active on mount

    // Manually expand the unrelated node.
    const expandBtn = screen.getByLabelText('Expand');
    fireEvent.mouseDown(expandBtn);
    fireEvent.click(expandBtn);

    expect(screen.getByText('Quickstart')).toBeInTheDocument(); // it expanded…
    expect(scrollIntoView).not.toHaveBeenCalled();              // …but did NOT jump to the active row
  });
});

describe('SidebarTreeNode memoization', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockTreeData = { ...defaultTreeData };
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
    });
  });

  const makeNode = (id: string, title: string, children: TreeNode[] = [], pageType: 'page' | 'folder' = 'page'): TreeNode => ({
    page: {
      id,
      spaceKey: 'DEV',
      title,
      pageType,
      parentId: null,
      labels: [],
      lastModifiedAt: '2026-03-01T00:00:00Z',
      embeddingDirty: false,
    },
    children,
  });

  it('is wrapped with React.memo and has a custom comparator', () => {
    const memoSymbol = Symbol.for('react.memo');
    const component = SidebarTreeNode as unknown as { $$typeof: symbol; compare: unknown };
    expect(component.$$typeof).toBe(memoSymbol);
    expect(typeof component.compare).toBe('function');
  });

  it('custom comparator returns true (skip re-render) when tracked props are identical by reference', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const expandedSet = new Set<string>();
    const props: SidebarTreeNodeProps = {
      node,
      level: 0,
      expandedSet,
      toggleExpand: vi.fn(),
      activePageId: 'page-1',
      isAiRoute: false,
    };

    expect(component.compare(props, { ...props, toggleExpand: vi.fn() })).toBe(true);
  });

  it('custom comparator returns false (re-render) when activePageId changes', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();
    const prev: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: false };
    const next: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: 'page-1', isAiRoute: false };

    expect(component.compare(prev, next)).toBe(false);
  });

  it('custom comparator returns false (re-render) when expandedSet reference changes', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const toggleExpand = vi.fn();
    const prev: SidebarTreeNodeProps = { node, level: 0, expandedSet: new Set<string>(), toggleExpand, activePageId: undefined, isAiRoute: false };
    const next: SidebarTreeNodeProps = { node, level: 0, expandedSet: new Set<string>(), toggleExpand, activePageId: undefined, isAiRoute: false };

    expect(component.compare(prev, next)).toBe(false);
  });

  it('custom comparator returns false (re-render) when isAiRoute changes (#960)', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();
    const prev: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: false };
    const next: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: true };

    expect(component.compare(prev, next)).toBe(false);
  });

  it('custom comparator returns false (re-render) when node reference changes', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();
    const node1 = makeNode('page-1', 'Test');
    const node2 = makeNode('page-1', 'Test Changed');
    const prev: SidebarTreeNodeProps = { node: node1, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: false };
    const next: SidebarTreeNodeProps = { node: node2, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: false };

    expect(component.compare(prev, next)).toBe(false);
  });

  it('renders correctly and shows content after memoization', () => {
    const node = makeNode('page-1', 'Memoized Page');
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={node}
          level={0}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Memoized Page')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Failure paths.
  //
  // The tree consumed only { data, isLoading }. A failed request therefore
  // left data undefined, the tree empty, and the EMPTY state on screen — "No
  // pages synced yet / Sync a Confluence space to get started", with a button
  // into Settings. The panel diagnosed a network failure as an unconfigured
  // integration and pointed the user at the most expensive wrong action it had.
  // Nothing exercised the path, which is why it survived.
  // ---------------------------------------------------------------------
  describe('failure paths', () => {
    beforeEach(() => {
      mockNavigate.mockClear();
      mockTreeData = { ...defaultTreeData };
      mockPinnedData = { items: [], total: 0 };
      mockCreatePageMutateAsync.mockClear();
      resetQueryState();
      useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarSpaceKey: undefined, treeSidebarWidth: 280 });
    });

  it('reports a failed load as a failure, not as an empty knowledge base', () => {
    mockTreeData = undefined;
    mockTreeQueryState = { isLoading: false, isError: true, error: new ApiError(500, 'Internal Server Error (HTTP 500)'), isFetching: false };

    render(<SidebarTreeView />, { wrapper: createWrapper() });

    expect(screen.getByTestId('tree-error')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load pages/)).toBeInTheDocument();
    // The curated ApiError message is the only place the user learns why.
    expect(screen.getByText('Internal Server Error (HTTP 500)')).toBeInTheDocument();

    // The wrong diagnosis must be absent — this is the actual regression guard.
    expect(screen.queryByText('No pages synced yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Sync a Confluence space to get started.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sync a Space/ })).not.toBeInTheDocument();
  });

  it('offers a retry that refetches, and says it is retrying', () => {
    mockTreeData = undefined;
    mockTreeQueryState = { isLoading: false, isError: true, error: new ApiError(503, 'Service Unavailable (HTTP 503)'), isFetching: false };

    const { rerender } = render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(mockRefetchTree).toHaveBeenCalledTimes(1);

    mockTreeQueryState = { ...mockTreeQueryState, isFetching: true };
    rerender(<SidebarTreeView />);
    const retrying = screen.getByRole('button', { name: /Retrying/ });
    expect(retrying).toBeDisabled();
  });

  it('falls back to generic copy when the failure is not an ApiError', () => {
    mockTreeData = undefined;
    mockTreeQueryState = { isLoading: false, isError: true, error: new TypeError('Failed to fetch'), isFetching: false };

    render(<SidebarTreeView />, { wrapper: createWrapper() });

    // A raw TypeError is not user-facing prose, so it is not shown.
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    expect(screen.getByText(/Your pages are still there/)).toBeInTheDocument();
  });

  it('keeps a cached tree usable when a refresh fails, and flags it', () => {
    // The common case: a background refetch failed but the last good tree is
    // still in hand. Replacing working navigation with an error screen would
    // take away what the user is mid-task in to report a cost not yet incurred.
    mockTreeQueryState = { isLoading: false, isError: true, error: new ApiError(504, 'Gateway Timeout (HTTP 504)'), isFetching: false };

    render(<SidebarTreeView />, { wrapper: createWrapper() });

    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-error')).not.toBeInTheDocument();

    const notice = screen.getByTestId('tree-stale-notice');
    expect(notice).toHaveTextContent('Showing the last loaded pages');
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(mockRefetchTree).toHaveBeenCalledTimes(1);
  });

  it('shows no failure treatment when the tree is genuinely empty', () => {
    mockTreeData = { items: [], total: 0 };

    render(<SidebarTreeView />, { wrapper: createWrapper() });

    expect(screen.getByText('No pages synced yet')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-stale-notice')).not.toBeInTheDocument();
  });

  it('surfaces a failed page creation and keeps the typed title', () => {
    // useCreatePage has no onError, and the catch here used to be commented
    // "error handled by mutation" — which was true of nothing. A failed create
    // closed nothing and said nothing.
    mockCreatePageState = { isPending: false, isError: true, error: new ApiError(409, 'A page with that title already exists (HTTP 409)') };

    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));

    const input = screen.getByLabelText('Title of the new page');
    fireEvent.change(input, { target: { value: 'Runbooks' } });

    const error = screen.getByTestId('new-page-error');
    expect(error).toHaveTextContent('A page with that title already exists (HTTP 409)');
    // Wired to the field, so it is announced with it rather than floating.
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', error.id);
    // And the work is not thrown away — retrying is a keystroke, not a retype.
    expect(input).toHaveValue('Runbooks');
  });

  it('clears a create failure when the title is edited or the field abandoned', () => {
    mockCreatePageState = { isPending: false, isError: true, error: new ApiError(409, 'Conflict (HTTP 409)') };

    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));

    fireEvent.change(screen.getByLabelText('Title of the new page'), { target: { value: 'Runbooks v2' } });
    expect(mockCreatePageReset).toHaveBeenCalled();

    mockCreatePageReset.mockClear();
    fireEvent.keyDown(screen.getByLabelText('Title of the new page'), { key: 'Escape' });
    expect(mockCreatePageReset).toHaveBeenCalled();
  });
  });

  it('has a New page button in the tree toolbar', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: 'New page' })).toBeInTheDocument();
    // "Folder" is gone: it promised a container and created a document.
    expect(screen.queryByRole('button', { name: /folder/i })).not.toBeInTheDocument();
  });

  it('shows the inline title input when New page is clicked', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const trigger = screen.getByRole('button', { name: 'New page' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByTestId('new-page-input')).toBeInTheDocument();
    expect(screen.getByLabelText('Title of the new page')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  // The label and the behaviour now agree. `folder` is a real page type that
  // the embedding, quality and summary workers all skip, so a control saying
  // "Folder" while creating a `page` promised an unindexed container and
  // returned an indexed document. The behaviour is deliberately unchanged —
  // whether this should instead create a true `pageType: 'folder'` is a
  // product decision with pipeline consequences, not a copy fix.
  it('creates a page, and says so', async () => {
    mockCreatePageMutateAsync.mockResolvedValue({ id: 'new-1' });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    const input = screen.getByLabelText('Title of the new page');
    fireEvent.change(input, { target: { value: 'Runbooks' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockCreatePageMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ pageType: 'page', title: 'Runbooks', bodyHtml: '' }),
    );
  });

  it('submits from the Create button, which names the action and stays inert until there is a title', () => {
    mockCreatePageMutateAsync.mockResolvedValue({ id: 'new-2' });
    render(<SidebarTreeView />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: 'New page' }));

    // "Create", not "Add" — "Add" beside a title field reads as adding the
    // title to something rather than creating the page.
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Title of the new page'), { target: { value: 'Postmortems' } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(mockCreatePageMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ pageType: 'page', title: 'Postmortems' }),
    );
  });

  it('abandons the inline input on Escape', () => {
    // This describe block does not reset the create mock between tests.
    mockCreatePageMutateAsync.mockClear();
    render(<SidebarTreeView />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    const input = screen.getByLabelText('Title of the new page');
    fireEvent.change(input, { target: { value: 'Half-typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('new-page-input')).not.toBeInTheDocument();
    expect(mockCreatePageMutateAsync).not.toHaveBeenCalled();

    // Reopening starts clean rather than restoring the abandoned draft.
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    expect(screen.getByLabelText('Title of the new page')).toHaveValue('');
  });

  it('pages with pageType folder navigate on click like normal pages', () => {
    mockTreeData = {
      items: [
        { id: 'folder-1', spaceKey: 'DEV', title: 'My Folder', pageType: 'folder' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
        { id: 'child-1', spaceKey: 'DEV', title: 'Child Page', pageType: 'page' as const, parentId: 'folder-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
      ],
      total: 2,
    };
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('My Folder')).toBeInTheDocument();
    mockNavigate.mockClear();
    fireEvent.click(screen.getByText('My Folder'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/folder-1');
    expect(screen.getByText('Child Page')).toBeInTheDocument();
  });

  it('renders indent guide line for expanded node with children', () => {
    const child1 = makeNode('child-1', 'Child 1');
    const child2 = makeNode('child-2', 'Child 2');
    const parent = makeNode('parent', 'Parent', [child1, child2]);
    const expandedSet = new Set<string>(['parent']);
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={0}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    const guide = screen.getByLabelText('Collapse Parent');
    expect(guide).toBeInTheDocument();
    expect(guide).toHaveClass('indent-guide');
    expect(guide.style.left).toBe('8px'); // level=0 => 0*12 + 8
  });

  it('calls toggleExpand when indent guide is clicked', () => {
    const child = makeNode('child-1', 'Child');
    const parent = makeNode('parent', 'Parent', [child]);
    const expandedSet = new Set<string>(['parent']);
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={0}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByLabelText('Collapse Parent'));
    expect(toggleExpand).toHaveBeenCalledWith('parent');
  });

  it('positions indent guide at correct offset for deeply nested nodes', () => {
    const child = makeNode('child-1', 'Deep Child');
    const parent = makeNode('parent', 'Deep Parent', [child]);
    const expandedSet = new Set<string>(['parent']);
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={3}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    const guide = screen.getByLabelText('Collapse Deep Parent');
    // level=3 => left = 3*12+8 = 44px
    expect(guide.style.left).toBe('44px');
  });

  // ---------------------------------------------------------------------
  // Keyboard and landmark semantics.
  // ---------------------------------------------------------------------

  it('keeps exactly one tab stop no matter how many parents are expanded', () => {
    // The tree's roving tabindex promises "exactly one row is ever
    // tab-stoppable". Every chevron was a plain <button> with no tabIndex, so
    // it was natively focusable and the promise was false: a 20-parent tree was
    // 21 tab stops. Nothing is lost by removing them — the row carries
    // aria-expanded and sidebar-tree-keyboard handles ArrowRight/ArrowLeft.
    const tree = makeNode('p', 'Parent', [
      makeNode('c1', 'Child 1', [makeNode('g1', 'Grandchild')]),
      makeNode('c2', 'Child 2'),
    ]);

    const { container } = render(
      <MemoryRouter>
        <SidebarTreeNode
          node={tree}
          level={0}
          expandedSet={new Set(['p', 'c1'])}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          isAiRoute={false}
          rovingId="p"
          onRowFocus={vi.fn()}
          onRowKeyDown={vi.fn()}
        />
      </MemoryRouter>,
    );

    const tabStops = [...container.querySelectorAll<HTMLElement>('a,button,[tabindex]')]
      .filter((el) => el.getAttribute('tabindex') !== '-1');
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0].getAttribute('role')).toBe('treeitem');
    // Four rows rendered, so this is not passing by rendering nothing.
    expect(screen.getAllByRole('treeitem')).toHaveLength(4);
  });

  it('hides the chevron and indent guide from assistive tech', () => {
    const parent = makeNode('parent', 'Parent', [makeNode('child-1', 'Child')]);

    const { container } = render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={0}
          expandedSet={new Set(['parent'])}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    // Both are mouse shortcuts for something the row already exposes; two
    // announced ways to collapse the same node is noise, and the chevron's
    // bare "Collapse" named nothing anyway.
    const chevron = screen.getByLabelText('Collapse');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(chevron).toHaveAttribute('tabindex', '-1');

    const guide = container.querySelector('.indent-guide')!;
    expect(guide).toHaveAttribute('aria-hidden', 'true');
    expect(guide).toHaveAttribute('tabindex', '-1');

    // The row remains the control, and still says so.
    expect(screen.getAllByRole('treeitem')[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('stays a named complementary landmark in both expanded and collapsed states', () => {
    const { unmount } = render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByRole('complementary', { name: 'Page tree' })).toBeInTheDocument();
    unmount();

    // Collapsing used to render a <div>, deleting the landmark outright — a
    // screen-reader user who collapsed the tree lost the region, not just its
    // contents.
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByRole('complementary', { name: 'Page tree' })).toBeInTheDocument();
  });

  it('keeps the current scope visible on the collapsed rail', () => {
    // Collapsing dropped every trace of scope — not the space, not the open
    // page, not the count — so the rail could not answer "which space am I in?"
    // and expanding was the only way to find out.
    useUiStore.setState({ treeSidebarCollapsed: true, treeSidebarSpaceKey: 'DEV' });
    render(<SidebarTreeView />, { wrapper: createWrapper() });

    const scope = screen.getByTestId('rail-space-scope');
    expect(scope).toHaveAccessibleName(/Development/);

    // It is also the way back: activating it expands the panel.
    fireEvent.click(scope);
    expect(useUiStore.getState().treeSidebarCollapsed).toBe(false);
  });

  it('announces the resize handle width with a unit', () => {
    useUiStore.setState({ treeSidebarWidth: 320 });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // aria-valuenow alone announces a bare "320" on a control whose entire job
    // is a measurement.
    expect(screen.getByRole('separator', { name: 'Resize tree sidebar' }))
      .toHaveAttribute('aria-valuetext', '320 pixels');
  });

  // ---------------------------------------------------------------------
  // Row gutter (see SidebarTreeNode's style comment).
  //
  // These pin the reclaimed horizontal budget. The panel's job is choosing a
  // page, and at the old geometry 43 of 57 rendered rows truncated their title
  // with no `title` attribute and no hover card — you could not read what you
  // were choosing between. Every assertion below is a pixel the title got back,
  // so each one fails loudly if a future change quietly spends it again.
  // ---------------------------------------------------------------------

  it('hangs the chevron in the indent gutter rather than laying it out in the row', () => {
    const child = makeNode('child-1', 'Child');
    const parent = makeNode('parent', 'Parent', [child]);

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={2}
          expandedSet={new Set<string>()}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    const chevron = screen.getByLabelText('Expand');
    // Out of flow, so its width costs the title nothing...
    expect(chevron.className).toContain('absolute');
    // ...which is what lets the hit area be 24x24 (WCAG 2.5.8) for free. It was
    // an 18x18 in-flow button before, failing the minimum AND charging for it.
    expect(chevron.className).toContain('size-6');
    // Sits in the gutter at level*12 + 2.
    expect(chevron.style.left).toBe('26px');
    // Must outrank .indent-guide (z-index: 1): at a 12px indent a parent's
    // guide target overlaps its children's chevrons by ~6px, and the chevron
    // has to win those clicks or it collapses the parent instead.
    expect(chevron.className).toContain('z-10');
  });

  it('charges leaf rows nothing for a chevron they never show', () => {
    const leaf = makeNode('leaf', 'A leaf page');

    const { container } = render(
      <MemoryRouter>
        <SidebarTreeNode
          node={leaf}
          level={1}
          expandedSet={new Set<string>()}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    // No chevron and — the point — no placeholder holding its column either.
    expect(screen.queryByLabelText('Expand')).not.toBeInTheDocument();
    expect(container.querySelector('.w-\\[20px\\]')).toBeNull();

    // A leaf's title still starts on the same axis as a sibling parent's,
    // because the chevron is out of flow rather than simply deleted. Dropping
    // the placeholder from the FLOW instead would leave a ragged left edge
    // inside every sibling group.
    const row = container.querySelector<HTMLElement>('[data-page-id="leaf"]')!;
    expect(row.style.paddingLeft).toBe('40px'); // 1*12 + 28
  });

  it('renders no per-row file icon', () => {
    const { container } = render(
      <MemoryRouter>
        <SidebarTreeNode
          node={makeNode('leaf', 'A leaf page')}
          level={0}
          expandedSet={new Set<string>()}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    // The FileText glyph rendered on 100% of rows — identical on parents and
    // leaves — so it discriminated nothing while costing 21px of the title's
    // width including its gap. A leaf row now contains no svg at all.
    const row = container.querySelector<HTMLElement>('[data-page-id="leaf"]')!;
    expect(row.querySelectorAll('svg')).toHaveLength(0);
  });

  it('indents 12px per level, not 16', () => {
    const { container } = render(
      <MemoryRouter>
        <SidebarTreeNode
          node={makeNode('deep', 'Deep page')}
          level={4}
          expandedSet={new Set<string>()}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    const row = container.querySelector<HTMLElement>('[data-page-id="deep"]')!;
    expect(row.style.paddingLeft).toBe('76px'); // 4*12 + 28, was 4*16 + 10 = 74
  });

  it('does not render indent guide for expanded leaf nodes', () => {
    const node = makeNode('leaf', 'Leaf Node');
    const expandedSet = new Set<string>(['leaf']);
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={node}
          level={0}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Collapse Leaf Node')).not.toBeInTheDocument();
  });

  it('does not render indent guide for collapsed nodes with children', () => {
    const child = makeNode('child-1', 'Child');
    const parent = makeNode('parent', 'Collapsed Parent', [child]);
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={0}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
          isAiRoute={false}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Collapse Collapsed Parent')).not.toBeInTheDocument();
  });

  describe('empty state (no pages)', () => {
    beforeEach(() => {
      mockTreeData.items = [];
      mockTreeData.total = 0;
    });

    it('shows empty state icon when no pages exist', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      const iconContainer = document.querySelector('.rounded-full.bg-muted');
      expect(iconContainer).toBeInTheDocument();
    });

    it('shows "No pages synced yet" when no space is selected', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('No pages synced yet')).toBeInTheDocument();
    });

    it('shows "Sync a Space" CTA button when no space is selected', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('Sync a Space')).toBeInTheDocument();
    });

    it('navigates to /settings when "Sync a Space" is clicked', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByText('Sync a Space'));
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('shows "No pages in this space" when a space is selected', () => {
      useUiStore.setState({ treeSidebarSpaceKey: 'DEV' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('No pages in this space')).toBeInTheDocument();
    });

    it('does not show "Sync a Space" CTA when a space is selected', () => {
      useUiStore.setState({ treeSidebarSpaceKey: 'DEV' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.queryByText('Sync a Space')).not.toBeInTheDocument();
    });
  });

  describe('footer stats pluralization', () => {
    it('uses plural "pages" when total is not 1', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('4 pages')).toBeInTheDocument();
    });

    it('uses singular "page" when total is 1', () => {
      mockTreeData = { ...defaultTreeData, items: [defaultTreeData.items[0]!], total: 1 };
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('1 page')).toBeInTheDocument();
    });

    it('keeps the space-key suffix when a space is selected', () => {
      useUiStore.setState({ treeSidebarSpaceKey: 'DEV' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('4 pages in DEV')).toBeInTheDocument();
    });
  });

  // #960: memoized rows used to call useLocation() internally, so every
  // location / searchParams change re-rendered every row in the tree — the
  // memo comparator never got a chance to bail. The /ai signal is now passed
  // in as a stable `isAiRoute` prop derived once by the parent, so a row only
  // re-renders when one of its actually-tracked props changes.
  describe('does not subscribe to location (#960)', () => {
    function UrlChanger() {
      const [, setSearchParams] = useSearchParams();
      return (
        <button onClick={() => setSearchParams({ pageId: 'x' })}>change-url</button>
      );
    }

    it('does not re-render a memoized row when the URL/searchParams change', () => {
      mockUseNavigate.mockClear();
      const node = makeNode('page-1', 'Stable Row');
      const expandedSet = new Set<string>();
      const toggleExpand = vi.fn();

      render(
        // The root consumes no location, so only location-subscribing
        // descendants re-render when the URL changes. UrlChanger is a SIBLING
        // of the row (never an ancestor), so a re-render of the row can only
        // come from the row's own hook subscriptions — not from a parent.
        <MemoryRouter initialEntries={['/pages']}>
          <SidebarTreeNode
            node={node}
            level={0}
            expandedSet={expandedSet}
            toggleExpand={toggleExpand}
            activePageId={undefined}
            isAiRoute={false}
          />
          <UrlChanger />
        </MemoryRouter>,
      );

      // The row rendered once on mount → useNavigate called once.
      expect(mockUseNavigate).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByText('change-url'));

      // Before the fix the row consumed useLocation and re-rendered on the URL
      // change (useNavigate called a 2nd time). After the fix its props are
      // stable, the memo bails, and the row does not re-render (still 1).
      expect(mockUseNavigate).toHaveBeenCalledTimes(1);
    });
  });

  describe('space settings link', () => {
    it('shows a Space settings action for a selected local space and navigates to its settings route', () => {
      useUiStore.setState({ treeSidebarSpaceKey: 'NOTES' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('space-selector-toggle'));
      const link = screen.getByTestId('space-settings-link');
      expect(link).toBeInTheDocument();

      fireEvent.click(link);
      expect(mockNavigate).toHaveBeenCalledWith('/spaces/NOTES/settings');
    });

    it('does not show the Space settings action for a Confluence space (settings page is local-only)', () => {
      useUiStore.setState({ treeSidebarSpaceKey: 'DEV' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('space-selector-toggle'));
      expect(screen.queryByTestId('space-settings-link')).not.toBeInTheDocument();
    });

    it('does not show the Space settings action when All Spaces is selected', () => {
      useUiStore.setState({ treeSidebarSpaceKey: undefined });
      render(<SidebarTreeView />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('space-selector-toggle'));
      expect(screen.queryByTestId('space-settings-link')).not.toBeInTheDocument();
    });
  });

  describe('local space icons', () => {
    // The /spaces/new picker persists `spaces.icon`, and these are the surfaces
    // that consume it — before this, no component anywhere read the value back.

    beforeEach(() => {
      // The enclosing block's beforeEach resets the store but not this mock.
      mockLocalSpaces = [...defaultLocalSpaces];
    });

    it('renders the chosen icon on the selector chip for a selected local space', () => {
      mockLocalSpaces = [{ ...defaultLocalSpaces[0]!, icon: 'rocket' }];
      useUiStore.setState({ treeSidebarSpaceKey: 'NOTES' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });

      const chip = screen.getByTestId('space-selector-toggle');
      expect(chip.querySelector('svg.lucide-rocket')).not.toBeNull();
      expect(chip.querySelector('svg.lucide-hard-drive')).toBeNull();
    });

    it('falls back to the generic HardDrive mark when the local space has no icon', () => {
      useUiStore.setState({ treeSidebarSpaceKey: 'NOTES' });
      render(<SidebarTreeView />, { wrapper: createWrapper() });

      const chip = screen.getByTestId('space-selector-toggle');
      expect(chip.querySelector('svg.lucide-hard-drive')).not.toBeNull();
    });

    it('renders each local space row in the dropdown with its own icon', () => {
      mockLocalSpaces = [
        { ...defaultLocalSpaces[0]!, icon: 'rocket' },
        { ...defaultLocalSpaces[0]!, key: 'SCRATCH', name: 'Scratch', icon: null },
      ];
      render(<SidebarTreeView />, { wrapper: createWrapper() });

      fireEvent.click(screen.getByTestId('space-selector-toggle'));
      const notesRow = screen.getByRole('button', { name: /My Notes/ });
      expect(notesRow.querySelector('svg.lucide-rocket')).not.toBeNull();
      const scratchRow = screen.getByRole('button', { name: /Scratch/ });
      expect(scratchRow.querySelector('svg.lucide-hard-drive')).not.toBeNull();
    });
  });
});
