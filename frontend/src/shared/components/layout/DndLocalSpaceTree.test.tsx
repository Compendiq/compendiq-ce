import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DndLocalSpaceTree from './DndLocalSpaceTree';
import type { DndLocalSpaceTreeProps } from './DndLocalSpaceTree';
import type { TreeNode } from './SidebarTreeView';

// Mock @dnd-kit so we can test component logic without the full DnD runtime
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

function makeNode(
  id: string,
  title: string,
  children: TreeNode[] = [],
): TreeNode {
  return {
    page: {
      id,
      spaceKey: 'NOTES',
      title,
      pageType: 'page',
      parentId: null,
      labels: [],
      lastModifiedAt: '2026-03-01T00:00:00Z',
      embeddingDirty: false,
    },
    children,
  };
}

function renderTree(overrides: Partial<DndLocalSpaceTreeProps> = {}) {
  const defaultProps: DndLocalSpaceTreeProps = {
    tree: [
      makeNode('p1', 'Page One'),
      makeNode('p2', 'Page Two', [makeNode('p2-c1', 'Child of Two')]),
    ],
    expandedIds: new Set<string>(),
    toggleExpand: vi.fn(),
    activePageId: undefined,
    reorderPage: { mutate: vi.fn() },
  };

  const props = { ...defaultProps, ...overrides };

  return {
    ...render(
      <MemoryRouter>
        <DndLocalSpaceTree {...props} />
      </MemoryRouter>,
    ),
    props,
  };
}

describe('DndLocalSpaceTree', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders all root-level pages', () => {
    renderTree();
    expect(screen.getByText('Page One')).toBeInTheDocument();
    expect(screen.getByText('Page Two')).toBeInTheDocument();
  });

  it('does not render children when not expanded', () => {
    renderTree();
    expect(screen.queryByText('Child of Two')).not.toBeInTheDocument();
  });

  it('renders children when parent is in expandedIds', () => {
    renderTree({ expandedIds: new Set(['p2']) });
    expect(screen.getByText('Child of Two')).toBeInTheDocument();
  });

  it('shows drag handle for each node', () => {
    renderTree();
    const handles = screen.getAllByLabelText('Drag to reorder');
    expect(handles.length).toBeGreaterThanOrEqual(2);
  });

  it('navigates to page on click', () => {
    renderTree();
    fireEvent.click(screen.getByText('Page One'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/p1');
  });

  it('calls toggleExpand on expand button click for parent nodes', () => {
    const toggleExpand = vi.fn();
    renderTree({ toggleExpand });
    const expandBtn = screen.getByLabelText('Expand');
    fireEvent.click(expandBtn);
    expect(toggleExpand).toHaveBeenCalledWith('p2');
  });

  it('renders indent guide when a node with children is expanded', () => {
    renderTree({ expandedIds: new Set(['p2']) });
    const guide = screen.getByLabelText('Collapse Page Two');
    expect(guide).toBeInTheDocument();
    expect(guide).toHaveClass('indent-guide');
  });

  it('is the default export (compatible with React.lazy)', () => {
    expect(typeof DndLocalSpaceTree).toBe('function');
  });
});
