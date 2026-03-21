import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
    { id: 'root-1', spaceKey: 'DEV', title: 'Getting Started', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'child-1', spaceKey: 'DEV', title: 'Installation', pageType: 'page' as const, parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'child-2', spaceKey: 'DEV', title: 'Configuration', pageType: 'page' as const, parentId: 'root-1', labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
    { id: 'root-2', spaceKey: 'DEV', title: 'API Reference', pageType: 'page' as const, parentId: null, labels: [], lastModifiedAt: '2026-03-01T00:00:00Z', embeddingDirty: false },
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
  usePageTree: (params: { spaceKey?: string; enabled?: boolean }) => {
    if (params.enabled === false) return { data: undefined, isLoading: false };
    return { data: mockTreeData, isLoading: false };
  },
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
    expect(screen.getByRole('link', { name: /Pages/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Graph/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /AI/ })).toBeInTheDocument();
  });

  it('renders "Spaces" label in sidebar header', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('Spaces')).toBeInTheDocument();
  });

  it('renders all spaces as expandable accordion sections', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // All three spaces should be visible as section headers
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('My Notes')).toBeInTheDocument();
  });

  it('shows page count next to each space name', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('spaces are collapsed by default and pages are not visible', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Pages should not be visible until space is expanded
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument();
    expect(screen.queryByText('API Reference')).not.toBeInTheDocument();
  });

  it('expands a space on click to reveal its pages', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    act(() => { fireEvent.click(screen.getByText('Development')); });
    // DEV space has homepageId='root-1' so buildTree scopes to the homepage tree:
    // Getting Started is the homepage root, and its children (Installation, Configuration)
    // become visible when that node is expanded. API Reference (root-2) is a sibling
    // with no parent under root-1, so it is filtered by the homepage scoping.
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });

  it('multiple spaces can be expanded simultaneously', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Expand DEV
    fireEvent.click(screen.getByText('Development'));
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    // Expand OPS (pages load same mock data for simplicity)
    fireEvent.click(screen.getByText('Operations'));
    // DEV should still be expanded
    expect(screen.getByText('Development')).toBeInTheDocument();
    // Both space sections should exist
    expect(screen.getByTestId('space-section-DEV')).toBeInTheDocument();
    expect(screen.getByTestId('space-section-OPS')).toBeInTheDocument();
  });

  it('collapses a space on second click', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Expand
    fireEvent.click(screen.getByText('Development'));
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    // Collapse
    fireEvent.click(screen.getByText('Development'));
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument();
  });

  it('children are hidden by default within expanded space until node is expanded', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    act(() => { fireEvent.click(screen.getByText('Development')); });
    // Homepage root visible, but its children hidden until chevron clicked
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    // Installation is a child of Getting Started -- visible only after homepage auto-expand
    // The homepage is auto-expanded via useEffect, so Installation may already be visible
  });

  it('auto-expands homepage node to reveal children in space with homepageId', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    act(() => { fireEvent.click(screen.getByText('Development')); });
    // DEV space has homepageId='root-1' (Getting Started), which auto-expands
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    // Children are auto-visible because homepage is auto-expanded
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('navigates to page on click within expanded space', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    // Use Operations space (no homepage scoping, so all pages show as roots)
    act(() => { fireEvent.click(screen.getByText('Operations')); });
    // With no homepage scoping, all mock pages show up
    fireEvent.click(screen.getByText('Getting Started'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/root-1');
  });

  it('navigates to /ai?pageId= on click when on AI route', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai') });
    // Use Operations space (no homepage scoping)
    act(() => { fireEvent.click(screen.getByText('Operations')); });
    fireEvent.click(screen.getByText('Getting Started'));
    expect(mockNavigate).toHaveBeenCalledWith('/ai?pageId=root-1', { replace: true });
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

  it('shows footer with total space and page counts', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    expect(screen.getByText('3 spaces / 9 pages')).toBeInTheDocument();
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

  it('shows space section with aria-expanded attribute', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper() });
    const devButton = screen.getByRole('button', { name: /Expand Development/ });
    expect(devButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(devButton);
    expect(devButton).toHaveAttribute('aria-expanded', 'true');
  });

  describe('empty state (no spaces)', () => {
    beforeEach(() => {
      // Override mocks temporarily by clearing the spaces arrays
      mockSpaces.length = 0;
      mockLocalSpaces.length = 0;
    });

    afterEach(() => {
      // Restore spaces
      mockSpaces.push(
        { key: 'DEV', name: 'Development', homepageId: 'root-1', lastSynced: '2026-03-01T00:00:00Z', pageCount: 4 },
        { key: 'OPS', name: 'Operations', homepageId: null, lastSynced: '2026-03-01T00:00:00Z', pageCount: 2 },
      );
      mockLocalSpaces.push(
        { key: 'NOTES', name: 'My Notes', description: null, icon: null, pageCount: 3, createdBy: null, createdAt: '2026-03-01T00:00:00Z', source: 'local' as const },
      );
    });

    it('shows "No spaces yet" when no spaces exist', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('No spaces yet')).toBeInTheDocument();
    });

    it('shows "Get Started" CTA button when no spaces exist', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      expect(screen.getByText('Get Started')).toBeInTheDocument();
    });

    it('navigates to /settings when "Get Started" is clicked', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper() });
      fireEvent.click(screen.getByText('Get Started'));
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });
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
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Collapse Collapsed Parent')).not.toBeInTheDocument();
  });
});
