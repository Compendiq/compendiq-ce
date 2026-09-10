import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { flattenVisibleTree, useTreeRovingFocus } from './sidebar-tree-keyboard';
import type { TreeNode } from './sidebar-types';

function makeNode(id: string, children: TreeNode[] = []): TreeNode {
  return {
    page: {
      id,
      spaceKey: 'DEV',
      title: id,
      pageType: 'page',
      parentId: null,
      labels: [],
      lastModifiedAt: null,
      embeddingDirty: false,
    } as TreeNode['page'],
    children,
  };
}

describe('flattenVisibleTree', () => {
  const tree = [
    makeNode('a', [makeNode('a1'), makeNode('a2')]),
    makeNode('b'),
  ];

  it('lists only root rows when nothing is expanded', () => {
    const flat = flattenVisibleTree(tree, new Set());
    expect(flat.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('inserts a node\'s children immediately after it once expanded', () => {
    const flat = flattenVisibleTree(tree, new Set(['a']));
    expect(flat.map((e) => e.id)).toEqual(['a', 'a1', 'a2', 'b']);
  });

  it('records parentId and hasChildren for each entry', () => {
    const flat = flattenVisibleTree(tree, new Set(['a']));
    expect(flat.find((e) => e.id === 'a')).toMatchObject({ parentId: null, hasChildren: true });
    expect(flat.find((e) => e.id === 'a1')).toMatchObject({ parentId: 'a', hasChildren: false });
    expect(flat.find((e) => e.id === 'b')).toMatchObject({ parentId: null, hasChildren: false });
  });

  it('does not descend into a collapsed node even if it has children', () => {
    const flat = flattenVisibleTree(tree, new Set());
    expect(flat.some((e) => e.id === 'a1')).toBe(false);
  });
});

describe('useTreeRovingFocus', () => {
  function setup(overrides: { activePageId?: string; expandedSet?: Set<string> } = {}) {
    const tree = [
      makeNode('a', [makeNode('a1'), makeNode('a2')]),
      makeNode('b'),
    ];
    const toggleExpand = vi.fn();
    const container = document.createElement('div');
    for (const id of ['a', 'a1', 'a2', 'b']) {
      const row = document.createElement('div');
      row.setAttribute('data-page-id', id);
      row.tabIndex = -1;
      container.appendChild(row);
    }
    document.body.appendChild(container);
    const containerRef = { current: container };

    const { result, rerender } = renderHook(
      (props: { expandedSet: Set<string>; activePageId: string | undefined }) =>
        useTreeRovingFocus({
          tree,
          expandedSet: props.expandedSet,
          activePageId: props.activePageId,
          toggleExpand,
          containerRef,
        }),
      { initialProps: { expandedSet: overrides.expandedSet ?? new Set<string>(), activePageId: overrides.activePageId } },
    );

    return { result, rerender, toggleExpand, container };
  }

  it('defaults the roving id to the first visible row when nothing is active', () => {
    const { result } = setup();
    expect(result.current.rovingId).toBe('a');
  });

  it('defaults the roving id to the active page when one is set', () => {
    const { result } = setup({ activePageId: 'b' });
    expect(result.current.rovingId).toBe('b');
  });

  it('falls back to the active page id even if it is not first in the tree', () => {
    const { result } = setup({ activePageId: 'a2', expandedSet: new Set(['a']) });
    expect(result.current.rovingId).toBe('a2');
  });

  it('moves the roving id down and up with ArrowDown/ArrowUp', () => {
    const { result } = setup();
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a',
      );
    });
    expect(result.current.rovingId).toBe('b');

    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowUp', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'b',
      );
    });
    expect(result.current.rovingId).toBe('a');
  });

  it('does not move past the last row on ArrowDown', () => {
    const { result } = setup({ activePageId: 'b' });
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'b',
      );
    });
    expect(result.current.rovingId).toBe('b');
  });

  it('expands a collapsed parent on ArrowRight without moving focus off it', () => {
    const { result, toggleExpand } = setup();
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowRight', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a',
      );
    });
    expect(toggleExpand).toHaveBeenCalledWith('a');
    expect(result.current.rovingId).toBe('a');
  });

  it('moves into the first child on ArrowRight when already expanded', () => {
    const { result } = setup({ expandedSet: new Set(['a']) });
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowRight', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a',
      );
    });
    expect(result.current.rovingId).toBe('a1');
  });

  it('collapses an expanded parent on ArrowLeft without moving focus', () => {
    const { result, toggleExpand } = setup({ expandedSet: new Set(['a']), activePageId: 'a' });
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowLeft', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a',
      );
    });
    expect(toggleExpand).toHaveBeenCalledWith('a');
    expect(result.current.rovingId).toBe('a');
  });

  it('moves to the parent on ArrowLeft from a child row', () => {
    const { result } = setup({ expandedSet: new Set(['a']), activePageId: 'a1' });
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowLeft', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a1',
      );
    });
    expect(result.current.rovingId).toBe('a');
  });

  it('jumps to the first/last row on Home/End', () => {
    const { result } = setup({ expandedSet: new Set(['a']), activePageId: 'a2' });
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'End', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a2',
      );
    });
    expect(result.current.rovingId).toBe('b');

    act(() => {
      result.current.handleRowKeyDown(
        { key: 'Home', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'b',
      );
    });
    expect(result.current.rovingId).toBe('a');
  });

  it('moves real DOM focus onto the row after an arrow-key move', () => {
    const { result, container } = setup();
    act(() => {
      result.current.handleRowKeyDown(
        { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as React.KeyboardEvent,
        'a',
      );
    });
    const row = container.querySelector('[data-page-id="b"]');
    expect(document.activeElement).toBe(row);
  });

  it('syncs the roving id when a row is focused directly (click/Tab)', () => {
    const { result } = setup();
    act(() => {
      result.current.handleRowFocus('b');
    });
    expect(result.current.rovingId).toBe('b');
  });

  it('falls back off a roving id that scrolled out of the visible set (e.g. its parent collapsed)', () => {
    const { result, rerender } = setup({ expandedSet: new Set(['a']) });
    act(() => {
      result.current.handleRowFocus('a1');
    });
    expect(result.current.rovingId).toBe('a1');

    rerender({ expandedSet: new Set(), activePageId: undefined });
    expect(result.current.rovingId).toBe('a');
  });
});
