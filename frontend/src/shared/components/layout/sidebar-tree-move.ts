import { CollisionPriority, CollisionType, type CollisionDetector } from '@dnd-kit/abstract';
import type { TreeNode } from './sidebar-types';

export const ROOT_SORTABLE_GROUP = '__root__';
export const NEST_DROPPABLE_PREFIX = 'nest:';

/** Middle band of a row that means "drop to nest", not sibling reorder. */
export const NEST_ZONE_TOP = 0.28;
export const NEST_ZONE_BOTTOM = 0.72;

export function nestDroppableId(pageId: string): string {
  return `${NEST_DROPPABLE_PREFIX}${pageId}`;
}

export function pageIdFromNestDroppable(id: string | number | undefined | null): string | null {
  if (id == null) return null;
  const value = String(id);
  return value.startsWith(NEST_DROPPABLE_PREFIX)
    ? value.slice(NEST_DROPPABLE_PREFIX.length)
    : null;
}

export function findNode(tree: TreeNode[], id: string): TreeNode | undefined {
  for (const node of tree) {
    if (node.page.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

/** Descendant ids only — does not include `node` itself. */
export function descendantIdsOf(node: TreeNode): Set<string> {
  const ids = new Set<string>();
  const walk = (current: TreeNode) => {
    for (const child of current.children) {
      ids.add(child.page.id);
      walk(child);
    }
  };
  walk(node);
  return ids;
}

export function wouldCreateCycle(tree: TreeNode[], sourceId: string, targetParentId: string): boolean {
  if (sourceId === targetParentId) return true;
  const source = findNode(tree, sourceId);
  return source ? descendantIdsOf(source).has(targetParentId) : false;
}

export interface MoveTarget {
  id: string;
  title: string;
  depth: number;
}

/**
 * Pages a source article may nest under: every node except itself, its
 * descendants, and its current parent (already nested there — "Move to
 * top level" leaves). Depth is visual indent in the picker, not `pages.depth`.
 *
 * Current parent is skipped as a *row* but its other children are still
 * walked, so siblings remain valid targets.
 */
export function flattenMoveTargets(tree: TreeNode[], sourceId: string): MoveTarget[] {
  const source = findNode(tree, sourceId);
  const blocked = new Set<string>([sourceId]);
  const currentParentId = source?.page.parentId ?? null;
  if (source) {
    for (const id of descendantIdsOf(source)) blocked.add(id);
  }
  const out: MoveTarget[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (blocked.has(node.page.id)) continue;
      if (node.page.id !== currentParentId) {
        out.push({ id: node.page.id, title: node.page.title, depth });
      }
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

export function isNestZone(
  pointer: { x: number; y: number },
  rect: { left: number; right: number; top: number; bottom: number },
): boolean {
  const height = rect.bottom - rect.top;
  const width = rect.right - rect.left;
  if (height <= 0 || width <= 0) return false;
  if (pointer.x < rect.left || pointer.x > rect.right) return false;
  if (pointer.y < rect.top || pointer.y > rect.bottom) return false;
  const t = (pointer.y - rect.top) / height;
  return t >= NEST_ZONE_TOP && t <= NEST_ZONE_BOTTOM;
}

export type DropIntent =
  | { kind: 'none' }
  | { kind: 'reorder'; id: string; sortOrder: number }
  | { kind: 'reparent'; id: string; parentId: string | null };

export function resolveSidebarDrop(input: {
  canceled: boolean;
  sourceId: string;
  sourceIndex: number;
  initialIndex: number;
  group: string;
  initialGroup: string;
  targetId?: string | number;
  currentParentId: string | null;
  isIllegalParent: (parentId: string) => boolean;
}): DropIntent {
  if (input.canceled) return { kind: 'none' };

  const nestParent = pageIdFromNestDroppable(input.targetId);
  if (nestParent) {
    if (nestParent === input.sourceId) return { kind: 'none' };
    if (input.isIllegalParent(nestParent)) return { kind: 'none' };
    if (input.currentParentId === nestParent) return { kind: 'none' };
    return { kind: 'reparent', id: input.sourceId, parentId: nestParent };
  }

  // OptimisticSortingPlugin rewrites `group` when a foreign droppable
  // accepts the source. /reorder only renumbers the current sibling
  // group — a group change would persist the wrong index.
  if (input.initialGroup !== input.group) return { kind: 'none' };
  if (input.sourceIndex === input.initialIndex) return { kind: 'none' };
  return { kind: 'reorder', id: input.sourceId, sortOrder: input.sourceIndex };
}

/**
 * Pointer collision that only fires in the middle of the row, so the top/bottom
 * bands stay available for same-group sibling reorder.
 */
export const nestCollisionDetector: CollisionDetector = ({ droppable, dragOperation }) => {
  const pointer = dragOperation.position.current;
  const shape = droppable.shape;
  if (!pointer || !shape) return null;
  if (!isNestZone(pointer, shape.boundingRectangle)) return null;
  return {
    id: droppable.id,
    value: 1,
    type: CollisionType.PointerIntersection,
    priority: CollisionPriority.High,
  };
};
