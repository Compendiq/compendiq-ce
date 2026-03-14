import { useState, useMemo, useCallback, memo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  MapPin,
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Search,
  X,
  Check,
} from 'lucide-react';
import { AnimatePresence, m } from 'framer-motion';
import { cn } from '../lib/cn';
import { useSpaces } from '../hooks/use-spaces';
import { usePageTree } from '../hooks/use-pages';
import type { PageTreeItem } from '../hooks/use-pages';

// ── Types ───────────────────────────────────────────────────────────

export interface LocationSelection {
  spaceKey: string;
  parentId?: string;
  /** Breadcrumb trail from root to selected location */
  breadcrumb: string[];
}

interface TreeNode {
  page: PageTreeItem;
  children: TreeNode[];
}

interface LocationPickerProps {
  /** Currently selected space key */
  spaceKey: string;
  /** Currently selected parent page ID */
  parentId?: string;
  /** Called when user picks a location */
  onSelect: (selection: LocationSelection) => void;
  /** Exclude this page ID from the tree (e.g. when editing, can't be its own parent) */
  excludePageId?: string;
  /** Disabled state */
  disabled?: boolean;
}

// ── Tree builder ────────────────────────────────────────────────────

function buildTree(pages: PageTreeItem[], excludeId?: string): TreeNode[] {
  const filtered = excludeId ? pages.filter((p) => p.id !== excludeId) : pages;
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  filtered.forEach((page) => {
    nodeMap.set(page.id, { page, children: [] });
  });

  filtered.forEach((page) => {
    const node = nodeMap.get(page.id)!;
    if (page.parentId && nodeMap.has(page.parentId)) {
      nodeMap.get(page.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  function sortChildren(nodes: TreeNode[]) {
    nodes.sort((a, b) => a.page.title.localeCompare(b.page.title));
    nodes.forEach((n) => sortChildren(n.children));
  }
  sortChildren(roots);

  return roots;
}

/** Build breadcrumb trail for a given page ID */
function buildBreadcrumb(pages: PageTreeItem[], targetId: string): string[] {
  const idToPage = new Map(pages.map((p) => [p.id, p]));
  const trail: string[] = [];
  let current = idToPage.get(targetId);
  while (current) {
    trail.unshift(current.title);
    current = current.parentId ? idToPage.get(current.parentId) : undefined;
  }
  return trail;
}

/** Filter tree nodes by search query (keeps ancestors of matches) */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const lowerQuery = query.toLowerCase();

  function matches(node: TreeNode): TreeNode | null {
    const titleMatch = node.page.title.toLowerCase().includes(lowerQuery);
    const filteredChildren = node.children
      .map((child) => matches(child))
      .filter(Boolean) as TreeNode[];

    if (titleMatch || filteredChildren.length > 0) {
      return { page: node.page, children: filteredChildren };
    }
    return null;
  }

  return nodes.map((n) => matches(n)).filter(Boolean) as TreeNode[];
}

// ── Tree node component ─────────────────────────────────────────────

interface PickerTreeNodeProps {
  node: TreeNode;
  level: number;
  expandedIds: Set<string>;
  selectedId?: string;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

const PickerTreeNode = memo(function PickerTreeNode({
  node,
  level,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
}: PickerTreeNodeProps) {
  const isExpanded = expandedIds.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isSelected = node.page.id === selectedId;

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle(node.page.id);
    },
    [onToggle, node.page.id],
  );

  const handleSelect = useCallback(() => {
    onSelect(node.page.id);
  }, [onSelect, node.page.id]);

  return (
    <div>
      <button
        type="button"
        onClick={handleSelect}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors',
          isSelected
            ? 'bg-primary/15 text-primary font-medium'
            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {hasChildren ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={handleToggle}
            className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="w-[20px] shrink-0" />
        )}
        {hasChildren ? (
          isExpanded ? (
            <FolderOpen size={15} className="shrink-0 text-primary/80" />
          ) : (
            <Folder size={15} className="shrink-0 text-primary/70" />
          )
        ) : (
          <FileText size={15} className="shrink-0 text-muted-foreground/70" />
        )}
        <span className="truncate">{node.page.title}</span>
        {isSelected && (
          <Check size={14} className="ml-auto shrink-0 text-primary" />
        )}
      </button>

      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <PickerTreeNode
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// ── Space tree panel ────────────────────────────────────────────────

interface SpaceTreePanelProps {
  spaceKey: string;
  selectedParentId?: string;
  excludePageId?: string;
  searchQuery: string;
  onSelectParent: (parentId: string | undefined) => void;
}

function SpaceTreePanel({
  spaceKey,
  selectedParentId,
  excludePageId,
  searchQuery,
  onSelectParent,
}: SpaceTreePanelProps) {
  const { data: treeData, isLoading } = usePageTree({ spaceKey });
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const pages = useMemo(() => treeData?.items ?? [], [treeData]);
  const tree = useMemo(() => buildTree(pages, excludePageId), [pages, excludePageId]);
  const filteredTree = useMemo(
    () => (searchQuery ? filterTree(tree, searchQuery) : tree),
    [tree, searchQuery],
  );

  // When filtering, auto-expand all nodes for visibility
  const effectiveExpanded = useMemo(() => {
    if (!searchQuery) return expandedIds;
    const allIds = new Set<string>();
    function collectIds(nodes: TreeNode[]) {
      nodes.forEach((n) => {
        allIds.add(n.page.id);
        collectIds(n.children);
      });
    }
    collectIds(filteredTree);
    return allIds;
  }, [searchQuery, expandedIds, filteredTree]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-1.5 px-1 py-2">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="h-6 animate-pulse rounded bg-foreground/5"
            style={{ width: `${60 + Math.random() * 30}%` }}
          />
        ))}
      </div>
    );
  }

  if (filteredTree.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
        {searchQuery ? 'No pages matching search.' : 'No pages in this space yet.'}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {filteredTree.map((node) => (
        <PickerTreeNode
          key={node.page.id}
          node={node}
          level={0}
          expandedIds={effectiveExpanded}
          selectedId={selectedParentId}
          onToggle={toggleExpand}
          onSelect={onSelectParent}
        />
      ))}
    </div>
  );
}

// ── Main LocationPicker component ───────────────────────────────────

export function LocationPicker({
  spaceKey,
  parentId,
  onSelect,
  excludePageId,
  disabled = false,
}: LocationPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedParentId, setSelectedParentId] = useState<string | undefined>(parentId);
  const { data: spaces } = useSpaces();
  const { data: treeData } = usePageTree({ spaceKey });

  // Compute display breadcrumb from current selection
  const displayBreadcrumb = useMemo(() => {
    const pages = treeData?.items ?? [];
    const spaceName = spaces?.find((s) => s.key === spaceKey)?.name ?? spaceKey;
    if (!parentId) return [spaceName, 'Root'];
    const trail = buildBreadcrumb(pages, parentId);
    return [spaceName, ...trail];
  }, [treeData, spaces, spaceKey, parentId]);

  const handleSelectParent = useCallback(
    (newParentId: string | undefined) => {
      setSelectedParentId(newParentId);
    },
    [],
  );

  const handleConfirm = useCallback(() => {
    const pages = treeData?.items ?? [];
    const breadcrumb = selectedParentId
      ? [
          spaces?.find((s) => s.key === spaceKey)?.name ?? spaceKey,
          ...buildBreadcrumb(pages, selectedParentId),
        ]
      : [spaces?.find((s) => s.key === spaceKey)?.name ?? spaceKey, 'Root'];

    onSelect({
      spaceKey,
      parentId: selectedParentId,
      breadcrumb,
    });
    setOpen(false);
    setSearchQuery('');
  }, [selectedParentId, spaceKey, onSelect, treeData, spaces]);

  const handleClearParent = useCallback(() => {
    setSelectedParentId(undefined);
  }, []);

  // Sync internal state when prop changes
  useMemo(() => {
    setSelectedParentId(parentId);
  }, [parentId]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled || !spaceKey}>
        <button
          type="button"
          className={cn(
            'glass-input flex items-center gap-2 text-left text-sm',
            disabled && 'cursor-not-allowed opacity-50',
            !spaceKey && 'cursor-not-allowed opacity-50',
          )}
          aria-label="Select page location"
        >
          <MapPin size={14} className="shrink-0 text-primary/70" />
          <span className="flex-1 truncate">
            {spaceKey ? (
              <span className="flex items-center gap-1 text-xs">
                {displayBreadcrumb.map((segment, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight size={10} className="text-muted-foreground/50" />}
                    <span className={i === displayBreadcrumb.length - 1 ? 'text-foreground' : 'text-muted-foreground'}>
                      {segment}
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">Select a space first</span>
            )}
          </span>
        </button>
      </Popover.Trigger>

      <AnimatePresence>
        {open && (
          <Popover.Portal forceMount>
            <Popover.Content
              asChild
              side="bottom"
              align="start"
              sideOffset={4}
              className="z-50"
            >
              <m.div
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="w-80 rounded-lg border border-border/50 bg-card shadow-xl backdrop-blur-xl"
              >
                {/* Search bar */}
                <div className="border-b border-border/40 p-2">
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search pages..."
                      className="glass-input w-full pl-8 pr-8 text-xs"
                      autoFocus
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        aria-label="Clear search"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Root option */}
                <div className="border-b border-border/40 px-2 py-1">
                  <button
                    type="button"
                    onClick={handleClearParent}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                      !selectedParentId
                        ? 'bg-primary/15 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                    )}
                  >
                    <Folder size={14} className="shrink-0" />
                    <span>Root level (no parent)</span>
                    {!selectedParentId && <Check size={12} className="ml-auto text-primary" />}
                  </button>
                </div>

                {/* Page tree */}
                <div className="max-h-64 overflow-y-auto p-1.5">
                  <SpaceTreePanel
                    spaceKey={spaceKey}
                    selectedParentId={selectedParentId}
                    excludePageId={excludePageId}
                    searchQuery={searchQuery}
                    onSelectParent={handleSelectParent}
                  />
                </div>

                {/* Footer with confirm button */}
                <div className="flex items-center justify-end border-t border-border/40 p-2">
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className="glass-button-primary text-xs"
                  >
                    <Check size={12} /> Confirm
                  </button>
                </div>
              </m.div>
            </Popover.Content>
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  );
}
