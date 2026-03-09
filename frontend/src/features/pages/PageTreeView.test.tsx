import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { PageTreeView, buildTree, countDescendants } from './PageTreeView';
import type { PageTreeItem } from '../../shared/hooks/use-pages';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <LazyMotion features={domAnimation}>
        {children}
      </LazyMotion>
    </MemoryRouter>
  );
}

function makePage(overrides: Partial<PageTreeItem> = {}): PageTreeItem {
  return {
    id: 'page-1',
    spaceKey: 'DEV',
    title: 'Test Page',
    parentId: null,
    labels: [],
    lastModifiedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

const hierarchyPages: PageTreeItem[] = [
  makePage({ id: 'root-1', title: 'Root Page 1', parentId: null }),
  makePage({ id: 'child-1a', title: 'Child 1A', parentId: 'root-1' }),
  makePage({ id: 'child-1b', title: 'Child 1B', parentId: 'root-1' }),
  makePage({ id: 'grandchild-1a1', title: 'Grandchild 1A1', parentId: 'child-1a' }),
  makePage({ id: 'root-2', title: 'Root Page 2', parentId: null }),
];

describe('buildTree', () => {
  it('builds a tree from flat page list', () => {
    const tree = buildTree(hierarchyPages);
    expect(tree).toHaveLength(2); // 2 root nodes
    expect(tree[0].page.title).toBe('Root Page 1');
    expect(tree[0].children).toHaveLength(2);
    expect(tree[1].page.title).toBe('Root Page 2');
    expect(tree[1].children).toHaveLength(0);
  });

  it('nests grandchildren correctly', () => {
    const tree = buildTree(hierarchyPages);
    const child1a = tree[0].children.find((c) => c.page.id === 'child-1a');
    expect(child1a?.children).toHaveLength(1);
    expect(child1a?.children[0].page.title).toBe('Grandchild 1A1');
  });

  it('treats orphaned children as roots', () => {
    const pages = [
      makePage({ id: 'orphan', title: 'Orphan', parentId: 'nonexistent' }),
    ];
    const tree = buildTree(pages);
    expect(tree).toHaveLength(1);
    expect(tree[0].page.title).toBe('Orphan');
  });

  it('handles empty array', () => {
    const tree = buildTree([]);
    expect(tree).toHaveLength(0);
  });

  it('roots tree at homepage children when homepageId is provided', () => {
    const pages: PageTreeItem[] = [
      makePage({ id: 'home', title: 'Home', parentId: null }),
      makePage({ id: 'child-a', title: 'Child A', parentId: 'home' }),
      makePage({ id: 'child-b', title: 'Child B', parentId: 'home' }),
      makePage({ id: 'grandchild', title: 'Grandchild', parentId: 'child-a' }),
    ];
    const tree = buildTree(pages, 'home');
    expect(tree).toHaveLength(2);
    expect(tree[0].page.title).toBe('Child A');
    expect(tree[1].page.title).toBe('Child B');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].page.title).toBe('Grandchild');
  });

  it('falls back to normal roots when homepageId not found', () => {
    const tree = buildTree(hierarchyPages, 'nonexistent-id');
    expect(tree).toHaveLength(2); // same as without homepageId
  });

  it('falls back to normal roots when homepageId is null', () => {
    const tree = buildTree(hierarchyPages, null);
    expect(tree).toHaveLength(2);
  });
});

describe('countDescendants', () => {
  it('counts all descendants recursively', () => {
    const tree = buildTree(hierarchyPages);
    const root1 = tree[0];
    expect(countDescendants(root1)).toBe(3); // 2 children + 1 grandchild
  });

  it('returns 0 for leaf nodes', () => {
    const tree = buildTree(hierarchyPages);
    const root2 = tree[1];
    expect(countDescendants(root2)).toBe(0);
  });
});

describe('PageTreeView', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders tree nodes', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    expect(screen.getByText('Root Page 1')).toBeInTheDocument();
    expect(screen.getByText('Root Page 2')).toBeInTheDocument();
  });

  it('shows page count summary', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    expect(screen.getByText('5 pages, 2 root nodes')).toBeInTheDocument();
  });

  it('children are hidden by default', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    expect(screen.queryByText('Child 1A')).not.toBeInTheDocument();
  });

  it('expands node on chevron click', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });

    // Find the expand button for root-1
    const expandBtns = screen.getAllByLabelText('Expand');
    fireEvent.click(expandBtns[0]);

    expect(screen.getByText('Child 1A')).toBeInTheDocument();
    expect(screen.getByText('Child 1B')).toBeInTheDocument();
  });

  it('collapses expanded node', async () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });

    // Expand
    const expandBtns = screen.getAllByLabelText('Expand');
    fireEvent.click(expandBtns[0]);
    expect(screen.getByText('Child 1A')).toBeInTheDocument();

    // Collapse
    const collapseBtn = screen.getByLabelText('Collapse');
    fireEvent.click(collapseBtn);
    await waitFor(() => {
      expect(screen.queryByText('Child 1A')).not.toBeInTheDocument();
    });
  });

  it('navigates to page on click', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Root Page 1'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/root-1');
  });

  it('shows Expand All and Collapse All buttons', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    expect(screen.getByText('Expand All')).toBeInTheDocument();
    expect(screen.getByText('Collapse All')).toBeInTheDocument();
  });

  it('Expand All shows all nested nodes', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText('Expand All'));

    expect(screen.getByText('Child 1A')).toBeInTheDocument();
    expect(screen.getByText('Child 1B')).toBeInTheDocument();
    expect(screen.getByText('Grandchild 1A1')).toBeInTheDocument();
  });

  it('Collapse All hides all nested nodes', async () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText('Expand All'));
    expect(screen.getByText('Child 1A')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Collapse All'));
    await waitFor(() => {
      expect(screen.queryByText('Child 1A')).not.toBeInTheDocument();
    });
  });

  it('shows descendant count for nodes with children', () => {
    render(<PageTreeView pages={hierarchyPages} />, { wrapper: Wrapper });
    // Root Page 1 has 3 descendants
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows empty state when no pages', () => {
    render(<PageTreeView pages={[]} />, { wrapper: Wrapper });
    expect(screen.getByText('No pages to display in tree view.')).toBeInTheDocument();
  });
});
