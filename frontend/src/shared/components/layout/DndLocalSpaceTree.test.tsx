import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DndLocalSpaceTree from './DndLocalSpaceTree';
import type { DndLocalSpaceTreeProps } from './DndLocalSpaceTree';
import type { TreeNode } from './sidebar-types';

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

  // #707: the scroll-into-view logic lives in the parent SidebarTreeView and
  // finds the open page by its data-active marker. The local-space tree must
  // tag the active row the same way so reload-positioning works here too.
  it('marks the active row with data-active="true" so the container can scroll to it', () => {
    renderTree({ activePageId: 'p1' });
    const active = document.querySelector('[data-active="true"]');
    expect(active).not.toBeNull();
    expect(active?.getAttribute('data-page-id')).toBe('p1');
  });

  it('does not mark any row active when no page is active', () => {
    renderTree({ activePageId: undefined });
    expect(document.querySelector('[data-active="true"]')).toBeNull();
  });

  it('marks a nested active row when its parent is expanded', () => {
    renderTree({ activePageId: 'p2-c1', expandedIds: new Set(['p2']) });
    const active = document.querySelector('[data-active="true"]');
    expect(active?.getAttribute('data-page-id')).toBe('p2-c1');
  });

  // #767: tree titles intermittently rendered faux-bold (synthesized weight
  // during variable-font load / compositing re-rasterization). The weight is
  // now pinned per-state on the title span so it can never float: exactly one
  // of font-normal / font-medium, never both (Tailwind class order between the
  // two utilities is unspecified, so conditional classes are mandatory).
  it('pins font-normal on inactive titles and font-medium on the active title (#767)', () => {
    renderTree({ activePageId: 'p1' });

    const activeTitle = screen.getByText('Page One');
    expect(activeTitle.className).toContain('font-medium');
    expect(activeTitle.className).not.toContain('font-normal');

    const inactiveTitle = screen.getByText('Page Two');
    expect(inactiveTitle.className).toContain('font-normal');
    expect(inactiveTitle.className).not.toContain('font-medium');
  });

  it('pins font-normal on every title when no page is active (#767)', () => {
    renderTree({ activePageId: undefined });

    for (const title of ['Page One', 'Page Two']) {
      const span = screen.getByText(title);
      expect(span.className).toContain('font-normal');
      expect(span.className).not.toContain('font-medium');
    }
  });

  // #880: local-space tree rows were clickable <div>s with no keyboard access —
  // reorder AND navigation were mouse-only. Each row is now a focusable
  // role="treeitem" that navigates on Enter/Space (WCAG 2.1.1).
  describe('keyboard navigation (#880)', () => {
    it('exposes each row as a focusable treeitem (role + tabIndex 0)', () => {
      renderTree();
      const row = screen.getByText('Page One').closest('[role="treeitem"]');
      expect(row).not.toBeNull();
      expect(row!.getAttribute('tabindex')).toBe('0');
    });

    it('navigates on Enter', () => {
      renderTree();
      const row = screen.getByText('Page One').closest('[role="treeitem"]')!;
      fireEvent.keyDown(row, { key: 'Enter' });
      expect(mockNavigate).toHaveBeenCalledWith('/pages/p1');
    });

    it('navigates on Space and prevents the default page-scroll', () => {
      renderTree();
      const row = screen.getByText('Page One').closest('[role="treeitem"]')!;
      const notPrevented = fireEvent.keyDown(row, { key: ' ' });
      expect(notPrevented).toBe(false);
      expect(mockNavigate).toHaveBeenCalledWith('/pages/p1');
    });

    it('exposes aria-expanded on an expandable row and omits it on a leaf', () => {
      renderTree();
      const expandable = screen.getByText('Page Two').closest('[role="treeitem"]')!;
      expect(expandable.getAttribute('aria-expanded')).toBe('false');
      const leaf = screen.getByText('Page One').closest('[role="treeitem"]')!;
      expect(leaf.getAttribute('aria-expanded')).toBeNull();
    });
  });
});
