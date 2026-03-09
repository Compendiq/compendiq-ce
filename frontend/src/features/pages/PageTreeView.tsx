import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { ChevronRight, ChevronDown, FileText, FolderOpen } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import type { PageTreeItem } from '../../shared/hooks/use-pages';

interface TreeNode {
  page: PageTreeItem;
  children: TreeNode[];
}

interface PageTreeViewProps {
  pages: PageTreeItem[];
  isLoading?: boolean;
}

function buildTree(pages: PageTreeItem[]): TreeNode[] {
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

  return roots;
}

function countDescendants(node: TreeNode): number {
  let count = node.children.length;
  node.children.forEach((child) => {
    count += countDescendants(child);
  });
  return count;
}

function TreeNodeComponent({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
}: {
  node: TreeNode;
  level?: number;
  expandedSet: Set<string>;
  toggleExpand: (id: string) => void;
}) {
  const navigate = useNavigate();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const descendantCount = useMemo(() => countDescendants(node), [node]);

  return (
    <div>
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className={cn(
          'glass-card-hover flex items-center gap-2 py-2 pr-3 text-left',
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
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-white/10"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* Page link */}
        <button
          onClick={() => navigate(`/pages/${node.page.id}`)}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {hasChildren ? (
            <FolderOpen size={16} className="shrink-0 text-primary" />
          ) : (
            <FileText size={16} className="shrink-0 text-primary" />
          )}
          <span className="truncate text-sm">{node.page.title}</span>
        </button>

        {/* Metadata */}
        <div className="flex shrink-0 items-center gap-2">
          {hasChildren && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {descendantCount}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">{node.page.spaceKey}</span>
          {node.page.lastModifiedAt && (
            <FreshnessBadge lastModified={node.page.lastModifiedAt} />
          )}
        </div>
      </m.div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <TreeNodeComponent
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedSet={expandedSet}
              toggleExpand={toggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PageTreeView({ pages }: PageTreeViewProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(pages), [pages]);

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
      <div className="mb-2 flex items-center gap-2 text-xs">
        <button
          onClick={expandAll}
          className="rounded px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          Expand All
        </button>
        <button
          onClick={collapseAll}
          className="rounded px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          Collapse All
        </button>
        <span className="ml-auto text-muted-foreground">
          {pages.length} pages, {tree.length} root nodes
        </span>
      </div>

      {/* Tree */}
      <div className="space-y-0.5">
        {tree.map((node) => (
          <TreeNodeComponent
            key={node.page.id}
            node={node}
            expandedSet={expandedIds}
            toggleExpand={toggleExpand}
          />
        ))}
      </div>
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { buildTree, countDescendants };
export type { TreeNode };
