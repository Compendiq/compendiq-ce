import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarTreeView, SidebarTreeNode } from './SidebarTreeView';
import type { TreeNode, SidebarTreeNodeProps } from './SidebarTreeView';
import { useUiStore } from '../../../stores/ui-store';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual('framer-motion');
  return { ...actual, useReducedMotion: () => true };
});

vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@dnd-kit/react/sortable', () => ({
  useSortable: () => ({ ref: { current: null }, isDragging: false }),
  isSortable: () => false,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const defaultTreeData = {
  items: [
    { id: 'root-1', spaceKey: 'DEV', title: 'Getting Started', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
    { id: 'child-1', spaceKey: 'DEV', title: 'Installation', pageType: 'page' as const, parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
    { id: 'child-2', spaceKey: 'DEV', title: 'Configuration', pageType: 'page' as const, parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
    { id: 'root-2', spaceKey: 'DEV', title: 'API Reference', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
  ],
  total: 4,
};

let mockTreeData = { ...defaultTreeData };

const mockSpaces = [
  { key: 'DEV', name: 'Development', homepageId: 'root-1', lastSynced: '2026-03-01T00:00:00Z', pageCount: 4 },
  { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 2 },
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

  it('renders nav tabs (Pages, Graph, AI) at the top of the sidebar', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(nav).toBeInTheDocument();
    // Nav tabs are in the sidebar
    expect(screen.getByRole('link', { name: /Pages/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Graph/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /AI/ })).toBeInTheDocument();
  });

  it('renders "Pages" label in sidebar header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // "Pages" appears both as nav tab and as the section label
    expect(screen.getAllByText('Pages').length).toBeGreaterThanOrEqual(1);
  });

  it('renders root pages', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
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

  it('shows indent guide line when a folder is expanded', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    fireEvent.click(expandBtn);
    expect(screen.getByLabelText('Collapse Getting Started')).toBeInTheDocument();
    expect(screen.getByLabelText('Collapse Getting Started')).toHaveClass('indent-guide');
  });

  it('collapses folder when indent guide line is clicked', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Expand first
    const expandBtn = screen.getAllByLabelText('Expand')[0];
    fireEvent.click(expandBtn);
    expect(screen.getByText('Installation')).toBeInTheDocument();
    // Click the indent guide to collapse
    fireEvent.click(screen.getByLabelText('Collapse Getting Started'));
    expect(screen.queryByText('Installation')).not.toBeInTheDocument();
  });

  it('positions indent guide at correct depth for nested levels', () => {
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'DEV',
    });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Homepage is auto-expanded, guide at level 0
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
    // Use child-1 (Installation, under root-1/Getting Started) since auto-select
    // scopes the tree to the DEV space homepage (root-1) and its descendants
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai?pageId=child-1') });
    // Child nodes should be auto-expanded via findAncestorIds
    const installRef = screen.getByText('Installation');
    // The active node row has the glass-pill-active class
    const row = installRef.parentElement!;
    expect(row.className).toContain('glass-pill-active');
  });

  it('shows collapsed state with expand toggle and nav icons when treeSidebarCollapsed is true', () => {
    useUiStore.setState({ treeSidebarCollapsed: true });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Section label hidden but nav icons and expand toggle still accessible
    expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument();
    // Nav icons shown as icon-only links in collapsed rail
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
    // Local space
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
    // Open the dropdown
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Development')).toBeInTheDocument();

    // Click outside (mousedown on the document body)
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Development')).not.toBeInTheDocument();
  });

  it('closes space dropdown on Escape key', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Open the dropdown
    fireEvent.click(screen.getByText('All Spaces'));
    expect(screen.getByText('Development')).toBeInTheDocument();

    // Press Escape
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

    // All SVG icons in the tree items should be the same type (FileText/document)
    // There should be no Folder or FolderOpen icons anywhere
    const svgs = container.querySelectorAll('svg');
    const svgClasses = Array.from(svgs).map((svg) => svg.getAttribute('class') ?? '');

    // None of the icons should be Folder or FolderOpen (lucide-folder or lucide-folder-open)
    // Note: lucide-folder-plus is allowed (it's the "New Folder" button in the header)
    const hasFolderIcon = svgClasses.some(
      (c) => c.includes('lucide-folder-open') || (c.includes('lucide-folder') && !c.includes('lucide-folder-plus')),
    );
    expect(hasFolderIcon).toBe(false);
  });

  it('keeps the homepage visible and expands its children when a space with homepageId is selected', () => {
    useUiStore.setState({
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: 'DEV',
    });
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.queryByText('API Reference')).not.toBeInTheDocument();
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
    // React.memo components have $$typeof = Symbol.for('react.memo')
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
    };

    // Same references for all compared props, different toggleExpand => should skip
    expect(component.compare(props, { ...props, toggleExpand: vi.fn() })).toBe(true);
  });

  it('custom comparator returns false (re-render) when activePageId changes', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();
    const prev: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: undefined };
    const next: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: 'page-1' };

    expect(component.compare(prev, next)).toBe(false);
  });

  it('custom comparator returns false (re-render) when expandedSet reference changes', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const toggleExpand = vi.fn();
    const prev: SidebarTreeNodeProps = { node, level: 0, expandedSet: new Set<string>(), toggleExpand, activePageId: undefined };
    const next: SidebarTreeNodeProps = { node, level: 0, expandedSet: new Set<string>(), toggleExpand, activePageId: undefined };

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
    const prev: SidebarTreeNodeProps = { node: node1, level: 0, expandedSet, toggleExpand, activePageId: undefined };
    const next: SidebarTreeNodeProps = { node: node2, level: 0, expandedSet, toggleExpand, activePageId: undefined };

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

  it('folder nodes show folder icon and do not navigate on click', () => {
    mockTreeData = {
      items: [
        { id: 'folder-1', spaceKey: 'DEV', title: 'My Folder', pageType: 'folder' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
        { id: 'child-1', spaceKey: 'DEV', title: 'Child Page', pageType: 'page' as const, parentId: 'folder-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z' },
      ],
      total: 2,
    };
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('My Folder')).toBeInTheDocument();
    mockNavigate.mockClear();
    fireEvent.click(screen.getByText('My Folder'));
    expect(mockNavigate).not.toHaveBeenCalled();
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
        />
      </MemoryRouter>,
    );

    const guide = screen.getByLabelText('Collapse Parent');
    expect(guide).toBeInTheDocument();
    expect(guide).toHaveClass('indent-guide');
    // level=0 => left = 0*16+14 = 14px
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
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Collapse Leaf Node')).not.toBeInTheDocument();
  });

  it('does not render indent guide for collapsed nodes with children', () => {
    const child = makeNode('child-1', 'Child');
    const parent = makeNode('parent', 'Collapsed Parent', [child]);
    const expandedSet = new Set<string>(); // not expanded
    const toggleExpand = vi.fn();

    render(
      <MemoryRouter>
        <SidebarTreeNode
          node={parent}
          level={0}
          expandedSet={expandedSet}
          toggleExpand={toggleExpand}
          activePageId={undefined}
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
      // FolderOpen icon is inside a rounded bg-muted container
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
});
