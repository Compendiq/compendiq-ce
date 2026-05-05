import { memo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  GripVertical,
} from 'lucide-react';
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react';
import { useSortable, isSortable } from '@dnd-kit/react/sortable';
import { cn } from '../../lib/cn';
import type { TreeNode } from './sidebar-types';

export interface DndLocalSpaceTreeProps {
  tree: TreeNode[];
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  activePageId: string | undefined;
  reorderPage: { mutate: (args: { id: string; sortOrder: number }) => void };
}

interface DndSortableTreeNodeProps {
  node: TreeNode;
  level?: number;
  expandedSet: Set<string>;
  toggleExpand: (id: string) => void;
  activePageId: string | undefined;
  sortableIndex: number;
}

const DndSortableTreeNode = memo(function DndSortableTreeNode({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
  activePageId,
  sortableIndex,
}: DndSortableTreeNodeProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;
  const isAiRoute = location.pathname === '/ai';

  const sortable = useSortable({
    id: node.page.id,
    index: sortableIndex,
    disabled: false,
  });

  const handleNavigate = useCallback(() => {
    if (hasChildren) toggleExpand(node.page.id);
    if (isAiRoute) {
      navigate(`/ai?pageId=${node.page.id}`, { replace: true });
    } else {
      navigate(`/pages/${node.page.id}`);
    }
  }, [navigate, node.page.id, hasChildren, toggleExpand, isAiRoute]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleExpand(node.page.id);
    },
    [toggleExpand, node.page.id],
  );

  return (
    <div ref={sortable.ref}>
      <div
        className={cn(
          'group flex items-center gap-1.5 rounded-[10px] h-9 pr-2 text-sm cursor-pointer transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isActive
            ? 'nm-pill-active text-primary font-medium scale-[1.01]'
            : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
        )}
        style={{ paddingLeft: `${level * 16 + 10}px` }}
        onClick={handleNavigate}
      >
        <span className="shrink-0 opacity-0 group-hover:opacity-50 cursor-grab active:cursor-grabbing transition-opacity" aria-label="Drag to reorder">
          <GripVertical size={12} />
        </span>
        {hasChildren ? (
          <button
            onClick={handleToggle}
            className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-[20px] shrink-0" />
        )}
        <FileText size={15} className={cn('shrink-0', isActive ? 'text-primary/80' : 'text-muted-foreground/70')} />
        <span className="truncate text-sm">{node.page.title}</span>
      </div>

      {hasChildren && isExpanded && (
        <div className="relative">
          {/* Indent guide line -- click to collapse parent */}
          <button
            type="button"
            onClick={handleToggle}
            className="indent-guide"
            style={{ left: `${level * 16 + 14}px` }}
            aria-label={`Collapse ${node.page.title}`}
            tabIndex={-1}
          />
          {node.children.map((child, idx) => (
            <DndSortableTreeNode
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedSet={expandedSet}
              toggleExpand={toggleExpand}
              activePageId={activePageId}
              sortableIndex={idx}
            />
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.node === next.node &&
    prev.level === next.level &&
    prev.activePageId === next.activePageId &&
    prev.expandedSet === next.expandedSet &&
    prev.sortableIndex === next.sortableIndex
  );
});

export default function DndLocalSpaceTree({
  tree,
  expandedIds,
  toggleExpand,
  activePageId,
  reorderPage,
}: DndLocalSpaceTreeProps) {
  const handleDragEnd = useCallback(
    (event: Parameters<DragEndEvent>[0]) => {
      if (event.canceled) return;
      const source = event.operation?.source;
      if (!source || !isSortable(source)) return;

      const currentIndex = source.index;
      const startIndex = 'initialIndex' in source ? (source as { initialIndex: number }).initialIndex : currentIndex;
      if (startIndex === currentIndex) return;

      const pageId = String(source.id);
      reorderPage.mutate({ id: pageId, sortOrder: currentIndex });
    },
    [reorderPage],
  );

  return (
    <DragDropProvider onDragEnd={handleDragEnd}>
      <div className="space-y-0.5">
        {tree.map((node, idx) => (
          <DndSortableTreeNode
            key={node.page.id}
            node={node}
            expandedSet={expandedIds}
            toggleExpand={toggleExpand}
            activePageId={activePageId}
            sortableIndex={idx}
          />
        ))}
      </div>
    </DragDropProvider>
  );
}
