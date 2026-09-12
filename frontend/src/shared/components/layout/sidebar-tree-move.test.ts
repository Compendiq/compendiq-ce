import { describe, it, expect } from 'vitest';
import type { TreeNode } from './sidebar-types';
import {
  descendantIdsOf,
  findNode,
  flattenMoveTargets,
  isNestZone,
  nestDroppableId,
  pageIdFromNestDroppable,
  resolveSidebarDrop,
  wouldCreateCycle,
} from './sidebar-tree-move';

function withParent(n: TreeNode, parentId: string): TreeNode {
  return {
    page: { ...n.page, parentId },
    children: n.children.map((c) => withParent(c, n.page.id)),
  };
}

function node(id: string, title: string, children: TreeNode[] = []): TreeNode {
  return {
    page: {
      id,
      spaceKey: 'NOTES',
      title,
      pageType: 'page',
      parentId: null,
      sortOrder: 0,
      labels: [],
      lastModifiedAt: null,
      embeddingDirty: false,
    },
    children: children.map((c) => withParent(c, id)),
  };
}

const tree: TreeNode[] = [
  node('a', 'Alpha'),
  node('b', 'Bravo', [
    node('b1', 'Bravo child', [node('b1a', 'Leaf')]),
  ]),
  node('c', 'Charlie'),
];

describe('sidebar-tree-move', () => {
  it('round-trips nest droppable ids', () => {
    expect(nestDroppableId('42')).toBe('nest:42');
    expect(pageIdFromNestDroppable('nest:42')).toBe('42');
    expect(pageIdFromNestDroppable('42')).toBeNull();
    expect(pageIdFromNestDroppable(undefined)).toBeNull();
  });

  it('finds nested nodes and lists only true descendants', () => {
    expect(findNode(tree, 'b1a')?.page.title).toBe('Leaf');
    expect(findNode(tree, 'missing')).toBeUndefined();
    expect([...descendantIdsOf(findNode(tree, 'b')!)]).toEqual(['b1', 'b1a']);
  });

  it('treats self and descendants as illegal parents', () => {
    expect(wouldCreateCycle(tree, 'b', 'b')).toBe(true);
    expect(wouldCreateCycle(tree, 'b', 'b1a')).toBe(true);
    expect(wouldCreateCycle(tree, 'b', 'c')).toBe(false);
    expect(wouldCreateCycle(tree, 'a', 'b1')).toBe(false);
  });

  it('omits the source article and its descendants from move targets', () => {
    expect(flattenMoveTargets(tree, 'b').map((t) => t.id)).toEqual(['a', 'c']);
    expect(flattenMoveTargets(tree, 'a').map((t) => t.id)).toEqual(['b', 'b1', 'b1a', 'c']);
    expect(flattenMoveTargets(tree, 'c').map((t) => `${t.id}:${t.depth}`)).toEqual([
      'a:0',
      'b:0',
      'b1:1',
      'b1a:2',
    ]);
  });

  it('omits the current parent but still lists siblings under it', () => {
    const withSibling: TreeNode[] = [
      node('a', 'Alpha'),
      node('b', 'Bravo', [
        node('b1', 'B1', [node('b1a', 'Leaf')]),
        node('b2', 'B2'),
      ]),
      node('c', 'Charlie'),
    ];
    expect(flattenMoveTargets(withSibling, 'b1').map((t) => t.id)).toEqual(['a', 'b2', 'c']);
  });

  it('treats the middle of a row as the nest zone and the edges as not', () => {
    const rect = { left: 0, right: 100, top: 0, bottom: 100 };
    expect(isNestZone({ x: 50, y: 50 }, rect)).toBe(true);
    expect(isNestZone({ x: 50, y: 10 }, rect)).toBe(false);
    expect(isNestZone({ x: 50, y: 90 }, rect)).toBe(false);
    // sidebar-drag-reorder E2E releases at 0.86 of the last row.
    expect(isNestZone({ x: 50, y: 86 }, rect)).toBe(false);
    expect(isNestZone({ x: -1, y: 50 }, rect)).toBe(false);
  });

  describe('resolveSidebarDrop', () => {
    const base = {
      canceled: false,
      sourceId: 'a',
      sourceIndex: 0,
      initialIndex: 0,
      group: '__root__',
      initialGroup: '__root__',
      currentParentId: null as string | null,
      isIllegalParent: (id: string) => wouldCreateCycle(tree, 'a', id),
    };

    it('reparents when the target is a nest droppable', () => {
      expect(resolveSidebarDrop({ ...base, targetId: nestDroppableId('c') })).toEqual({
        kind: 'reparent',
        id: 'a',
        parentId: 'c',
      });
    });

    it('ignores a nest onto self, a descendant, or the current parent', () => {
      expect(resolveSidebarDrop({ ...base, targetId: nestDroppableId('a') }).kind).toBe('none');
      expect(
        resolveSidebarDrop({
          ...base,
          sourceId: 'b',
          isIllegalParent: (id) => wouldCreateCycle(tree, 'b', id),
          targetId: nestDroppableId('b1'),
        }).kind,
      ).toBe('none');
      expect(
        resolveSidebarDrop({
          ...base,
          currentParentId: 'c',
          targetId: nestDroppableId('c'),
        }).kind,
      ).toBe('none');
    });

    it('reorders when the sibling index changed in the same group', () => {
      expect(
        resolveSidebarDrop({ ...base, sourceIndex: 2, initialIndex: 0 }),
      ).toEqual({ kind: 'reorder', id: 'a', sortOrder: 2 });
    });

    it('does not persist a same-index drop or a group change', () => {
      expect(resolveSidebarDrop(base).kind).toBe('none');
      expect(
        resolveSidebarDrop({ ...base, group: 'p2', initialGroup: '__root__', sourceIndex: 1 }).kind,
      ).toBe('none');
      expect(resolveSidebarDrop({ ...base, canceled: true, sourceIndex: 2 }).kind).toBe('none');
    });
  });
});
