import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import {
  ChevronRight,
  FileText,
  FolderOpen,
  Folder,
  ChevronsUpDown,
  ChevronsDownUp,
  Hash,
} from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import type { PageTreeItem } from '../../shared/hooks/use-pages';

interface TreeNode {
  page: PageTreeItem;
  children: TreeNode[];
}

interface PageTreeViewProps {
  pages: PageTreeItem[];
  homepageId?: string | null;
  isLoading?: boolean;
}

function buildTree(pages: PageTreeItem[], homepageId?: string | null): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Create all nodes
  pages.forEach((page) => {
    nodeMap.set(page.id, { page, children: [] });
  });

  // Build parent-child relationships
  pages.forEach((page) => {
    const node = nodeMap.get(page.id)!;
    if (page.parentId && nodeMap.has(page.parentId)) {
      nodeMap.get(page.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  // If homepageId is provided, root the tree at the homepage's children
  if (homepageId) {
    const homepageNode = nodeMap.get(homepageId);
    if (homepageNode) {
      return homepageNode.children;
    }
  }

  return roots;
}

function countDescendants(node: TreeNode): number {
  let count = node.children.length;
  node.children.forEach((child) => {
    count += countDescendants(child);
  });
  return count;
}

const childrenVariants = {
  hidden: { opacity: 0, height: 0 },
  visible: {
    opacity: 1,
    height: 'auto',
    transition: { duration: 0.2, ease: 'easeOut' as const },
  },
  exit: {
    opacity: 0,
    height: 0,
    transition: { duration: 0.15, ease: 'easeIn' as const },
  },
};

function TreeNodeComponent({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
  isLast = false,
}: {
  node: TreeNode;
  level?: number;
  expandedSet: Set<string>;
  toggleExpand: (id: string) => void;
  isLast?: boolean;
}) {
  const navigate = useNavigate();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const descendantCount = useMemo(() => countDescendants(node), [node]);

  return (
    <div className="relative">
      {/* Vertical connector line from parent */}
      {level > 0 && (
        <div
          className="absolute top-0 w-px bg-border/40"
          style={{
            left: `${(level - 1) * 20 + 22}px`,
            height: isLast ? '20px' : '100%',
          }}
          aria-hidden="true"
        />
      )}

      {/* Horizontal connector line to this node */}
      {level > 0 && (
        <div
          className="absolute top-[20px] h-px bg-border/40"
          style={{
            left: `${(level - 1) * 20 + 22}px`,
            width: '12px',
          }}
          aria-hidden="true"
        />
      )}

      <m.div
        initial={{ opacity: 0, x: -4 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.15, delay: level * 0.02 }}
        className={cn(
          'group relative flex items-center gap-2 rounded-lg py-2 pr-3 transition-colors',
          'hover:bg-white/[0.06]',
          level === 0 && 'font-medium',
        )}
        style={{ paddingLeft: `${level * 20 + 12}px` }}
      >
        {/* Expand/collapse button */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(node.page.id);
            }}
            className={cn(
              'shrink-0 rounded-md p-1 transition-all duration-200',
              'text-muted-foreground hover:bg-white/10 hover:text-foreground',
            )}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <m.div
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
            >
              <ChevronRight size={14} />
            </m.div>
          </button>
        ) : (
          <span className="w-[26px] shrink-0" />
        )}

        {/* Page link */}
        <button
          onClick={() => navigate(`/pages/${node.page.id}`)}
          className="flex min-w-0 flex-1 items-center gap-2.5"
        >
          <span
            className={cn(
              'flex shrink-0 items-center justify-center rounded-md p-1',
              hasChildren
                ? 'bg-primary/10 text-primary'
                : 'bg-muted/50 text-muted-foreground',
            )}
          >
            {hasChildren ? (
              isExpanded ? (
                <FolderOpen size={14} />
              ) : (
                <Folder size={14} />
              )
            ) : (
              <FileText size={14} />
            )}
          </span>
          <span className="truncate text-sm">{node.page.title}</span>
        </button>

        {/* Metadata — visible on hover or always on larger screens */}
        <div className="flex shrink-0 items-center gap-1.5 opacity-60 transition-opacity group-hover:opacity-100">
          {hasChildren && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
                'bg-primary/10 text-[10px] font-medium text-primary',
              )}
            >
              <Hash size={8} />
              {descendantCount}
            </span>
          )}
          <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
            {node.page.spaceKey}
          </span>
          {node.page.lastModifiedAt && (
            <FreshnessBadge lastModified={node.page.lastModifiedAt} />
          )}
        </div>
      </m.div>

      {/* Children with animated expand/collapse */}
      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && (
          <m.div
            key={`children-${node.page.id}`}
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={childrenVariants}
            className="relative overflow-hidden"
          >
            {node.children.map((child, index) => (
              <TreeNodeComponent
                key={child.page.id}
                node={child}
                level={level + 1}
                expandedSet={expandedSet}
                toggleExpand={toggleExpand}
                isLast={index === node.children.length - 1}
              />
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PageTreeView({ pages, homepageId }: PageTreeViewProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(pages, homepageId), [pages, homepageId]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expandAll = () => {
    const allIds = new Set<string>();
    function collect(nodes: TreeNode[]) {
      nodes.forEach((node) => {
        if (node.children.length > 0) {
          allIds.add(node.page.id);
          collect(node.children);
        }
      });
    }
    collect(tree);
    setExpandedIds(allIds);
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  if (tree.length === 0) {
    return (
      <div className="glass-card py-8 text-center text-sm text-muted-foreground">
        No pages to display in tree view.
      </div>
    );
  }

  return (
    <div>
      {/* Controls */}
      <div className="mb-3 flex items-center gap-1.5">
        <button
          onClick={expandAll}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors',
            'bg-white/[0.04] text-muted-foreground',
            'hover:bg-white/[0.08] hover:text-foreground',
          )}
        >
          <ChevronsUpDown size={13} />
          Expand All
        </button>
        <button
          onClick={collapseAll}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors',
            'bg-white/[0.04] text-muted-foreground',
            'hover:bg-white/[0.08] hover:text-foreground',
          )}
        >
          <ChevronsDownUp size={13} />
          Collapse All
        </button>
        <span className="ml-auto text-xs text-muted-foreground">
          {pages.length} pages, {tree.length} root nodes
        </span>
      </div>

      {/* Tree */}
      <div className="rounded-xl border border-white/[0.06] bg-card/40 p-2 backdrop-blur-sm">
        {tree.map((node, index) => (
          <TreeNodeComponent
            key={node.page.id}
            node={node}
            expandedSet={expandedIds}
            toggleExpand={toggleExpand}
            isLast={index === tree.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { buildTree, countDescendants };
export type { TreeNode };
