import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarTreeView, SidebarTreeNode } from './SidebarTreeView';
import type { TreeNode, SidebarTreeNodeProps } from './SidebarTreeView';
import { useUiStore } from '../../../stores/ui-store';

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

let mockTreeData = { ...defaultTreeData };

const mockSpaces = [
  { key: 'DEV', name: 'Development', homepageId: 'root-1', lastSynced: '2026-03-01T00:00:00Z', pageCount: 4, source: 'confluence' as const },
  { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 2, source: 'confluence' as const },
];

const mockLocalSpaces = [
  { key: 'NOTES', name: 'My Notes', description: null, icon: null, pageCount: 3, createdBy: null, createdAt: '2026-03-01T00:00:00Z', source: 'local' as const },
];

const mockCreatePageMutateAsync = vi.fn();
vi.mock('../../hooks/use-pages', () => ({
  usePageTree: () => ({ data: mockTreeData, isLoading: false }),
  useCreatePage: () => ({ mutateAsync: mockCreatePageMutateAsync, isPending: false }),
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
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
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

  it('active nav tab uses ink-action treatment, not amber text', () => {
    // location.pathname === '/' => Pages tab is active.
    render(<SidebarTreeView />, { wrapper: createWrapper('/') });
    const pagesLink = screen.getByRole('link', { name: /Pages/ });
    expect(pagesLink.className).toContain('bg-action');
    expect(pagesLink.className).toContain('text-action-foreground');
    expect(pagesLink.className).not.toContain('text-primary');
  });

  it('active AI tab keeps an amber icon as the AI signal even though pill is ink', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai') });
    const aiLink = screen.getByRole('link', { name: /AI/ });
    // At least one descendant element carries text-primary (the amber icon).
    const amberDescendant = aiLink.querySelector('[class*="text-primary"]');
    expect(amberDescendant).not.toBeNull();
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
    // level=0 => left = 0*16+14 = 14px
    expect(guide.style.left).toBe('14px');
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
    expect(row.className).toContain('bg-action');
    expect(row.className).toContain('text-action-foreground');
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
    expect(screen.getByRole('separator', { name: 'Resize tree sidebar' })).toBeInTheDocument();
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

  it('does not render resize handle when collapsed', () => {
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.queryByRole('separator', { name: 'Resize tree sidebar' })).not.toBeInTheDocument();
  });

  it('uses document icons for all pages, including parents with children (no folder icons)', () => {
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'DEV',
    });
    const { container } = render(<SidebarTreeView />, { wrapper: createWrapper() });

    const svgs = container.querySelectorAll('svg');
    const svgClasses = Array.from(svgs).map((svg) => svg.getAttribute('class') ?? '');

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

  it('has a New Space button in sidebar header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByLabelText('New Space')).toBeInTheDocument();
  });

  it('navigates to new space page when New Space is clicked in header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('New Space'));
    expect(mockNavigate).toHaveBeenCalledWith('/spaces/new');
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

  it('has a New Folder button in sidebar header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByLabelText('New Folder')).toBeInTheDocument();
  });

  it('shows new folder inline input when New Folder button is clicked', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('New Folder'));
    expect(screen.getByTestId('new-folder-input')).toBeInTheDocument();
    expect(screen.getByLabelText('New folder name')).toBeInTheDocument();
  });

  it('creates new folder as pageType "page" (not "folder")', async () => {
    mockCreatePageMutateAsync.mockResolvedValue({ id: 'new-1' });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByLabelText('New Folder'));
    const input = screen.getByLabelText('New folder name');
    fireEvent.change(input, { target: { value: 'My Container' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockCreatePageMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ pageType: 'page', title: 'My Container', bodyHtml: '' }),
    );
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
    expect(guide.style.left).toBe('14px');
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
    // level=3 => left = 3*16+14 = 62px
    expect(guide.style.left).toBe('62px');
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
});
