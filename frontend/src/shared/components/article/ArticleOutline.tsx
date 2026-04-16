import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronLeft, ChevronRight, ListTree } from 'lucide-react';
import { m } from 'framer-motion';
import { cn } from '../../lib/cn';
import type { TocHeading } from './TableOfContents';

interface OutlineNode {
  heading: TocHeading;
  children: OutlineNode[];
}

interface ArticleOutlineProps {
  headings: TocHeading[];
  contentRef: React.RefObject<HTMLElement | null>;
  pageId?: string;
  isOpen: boolean;
  onToggle: () => void;
}

function buildTree(headings: TocHeading[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const heading of headings) {
    const node: OutlineNode = { heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.heading.level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1]!.children.push(node);
    }

    stack.push(node);
  }

  return root;
}

function findAncestorIds(nodes: OutlineNode[], targetId: string): string[] | null {
  for (const node of nodes) {
    if (node.heading.id === targetId) return [];
    const result = findAncestorIds(node.children, targetId);
    if (result !== null) {
      return [node.heading.id, ...result];
    }
  }

  return null;
}

function readCollapsedIds(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

interface OutlineItemProps {
  activeId: string | null;
  collapsedIds: Set<string>;
  node: OutlineNode;
  onNavigate: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
}

function OutlineItem({
  activeId,
  collapsedIds,
  node,
  onNavigate,
  onToggleCollapsed,
}: OutlineItemProps) {
  const { heading, children } = node;
  const hasChildren = children.length > 0;
  const isOpen = !collapsedIds.has(heading.id);

  return (
    <li>
      <Collapsible.Root open={isOpen} onOpenChange={() => onToggleCollapsed(heading.id)}>
        <div className="flex items-start gap-1">
          {hasChildren ? (
            <Collapsible.Trigger asChild>
              <button
                className="mt-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label={isOpen ? 'Collapse outline section' : 'Expand outline section'}
              >
                <ChevronRight
                  size={12}
                  className={cn('transition-transform duration-150', isOpen && 'rotate-90')}
                />
              </button>
            </Collapsible.Trigger>
          ) : (
            <span className="mt-1 w-4 shrink-0" />
          )}

          <button
            onClick={() => onNavigate(heading.id)}
            className={cn(
              'flex-1 rounded-xl px-2.5 py-1.5 text-left text-sm transition-colors',
              heading.level === 1 && 'font-medium',
              heading.level === 2 && 'pl-4 text-[13px]',
              heading.level === 3 && 'pl-6 text-[13px]',
              heading.level >= 4 && 'pl-8 text-xs',
              activeId === heading.id
                ? 'bg-primary/12 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            {heading.text}
          </button>
        </div>

        {hasChildren && (
          <Collapsible.Content className="toc-collapsible-content">
            <ul className="space-y-1">
              {children.map((child) => (
                <OutlineItem
                  key={child.heading.id}
                  activeId={activeId}
                  collapsedIds={collapsedIds}
                  node={child}
                  onNavigate={onNavigate}
                  onToggleCollapsed={onToggleCollapsed}
                />
              ))}
            </ul>
          </Collapsible.Content>
        )}
      </Collapsible.Root>
    </li>
  );
}

export function ArticleOutline({
  headings,
  contentRef,
  pageId,
  isOpen,
  onToggle,
}: ArticleOutlineProps) {
  const storageKey = `article-outline-collapsed-${pageId ?? 'default'}`;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState(() => readCollapsedIds(storageKey));
  const [readingProgress, setReadingProgress] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const tree = useMemo(() => buildTree(headings), [headings]);

  useEffect(() => {
    setCollapsedIds(readCollapsedIds(storageKey));
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...collapsedIds]));
    } catch {
      // Ignore storage write failures.
    }
  }, [collapsedIds, storageKey]);

  useEffect(() => {
    if (headings.length === 0) return;

    const scrollRoot = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    const contentEl = contentRef.current;
    if (!scrollRoot || !contentEl) return;

    const headingElements = headings
      .map((heading) => contentEl.querySelector(`#${CSS.escape(heading.id)}`))
      .filter(Boolean) as HTMLElement[];

    if (headingElements.length === 0) return;

    observerRef.current?.disconnect();
    const handleIntersections: IntersectionObserverCallback = (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];

      if (visible?.target?.id) {
        setActiveId(visible.target.id);
      }
    };

    const observerOptions: IntersectionObserverInit = {
      root: scrollRoot,
      rootMargin: '-12% 0% -72% 0%',
      threshold: [0, 1],
    };

    try {
      observerRef.current = new IntersectionObserver(handleIntersections, observerOptions);
    } catch {
      observerRef.current = new IntersectionObserver();
      const mockObserver = observerRef.current as IntersectionObserver & {
        callback?: IntersectionObserverCallback;
        _callback?: IntersectionObserverCallback;
      };
      if (typeof mockObserver.callback === 'function' || typeof mockObserver.callback === 'undefined') {
        mockObserver.callback = handleIntersections;
      } else if (
        typeof mockObserver._callback === 'function' ||
        typeof mockObserver._callback === 'undefined'
      ) {
        mockObserver._callback = handleIntersections;
      }
    }

    headingElements.forEach((element) => observerRef.current?.observe(element));

    return () => observerRef.current?.disconnect();
  }, [contentRef, headings]);

  useEffect(() => {
    const ancestorIds = activeId ? findAncestorIds(tree, activeId) : null;
    if (!ancestorIds || ancestorIds.length === 0) return;

    setCollapsedIds((prev) => {
      if (!ancestorIds.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      ancestorIds.forEach((id) => next.delete(id));
      return next;
    });
  }, [activeId, tree]);

  useEffect(() => {
    const scrollRoot = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (!scrollRoot) return;

    const updateProgress = () => {
      const scrollHeight = scrollRoot.scrollHeight - scrollRoot.clientHeight;
      if (scrollHeight <= 0) {
        setReadingProgress(0);
        return;
      }

      setReadingProgress(Math.min(100, (scrollRoot.scrollTop / scrollHeight) * 100));
    };

    updateProgress();
    scrollRoot.addEventListener('scroll', updateProgress, { passive: true });
    return () => scrollRoot.removeEventListener('scroll', updateProgress);
  }, []);

  const handleToggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNavigate = useCallback((id: string) => {
    const scrollRoot = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    const target = contentRef.current?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
    if (!scrollRoot || !target) return;

    const targetRect = target.getBoundingClientRect();
    const rootRect = scrollRoot.getBoundingClientRect();
    const top = scrollRoot.scrollTop + targetRect.top - rootRect.top - 24;

    scrollRoot.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setActiveId(id);
  }, [contentRef]);

  const collapsedRail = (
    <aside
      className="sticky top-4 flex h-fit w-full justify-end xl:w-12"
      data-testid="article-outline-rail"
    >
      <button
        onClick={onToggle}
        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-card/80 text-muted-foreground shadow-sm backdrop-blur-xl transition-colors hover:bg-card hover:text-foreground"
        aria-label="Show outline"
      >
        <ChevronLeft size={16} />
      </button>
    </aside>
  );

  if (headings.length === 0) {
    return isOpen ? (
      <aside
        className="sticky top-4 h-fit rounded-[28px] border border-border/60 bg-card/75 p-4 shadow-sm backdrop-blur-xl"
        data-testid="article-outline-empty"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ListTree size={15} />
            Outline
          </div>
          <button
            onClick={onToggle}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            aria-label="Hide outline"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          This article has no headings yet.
        </p>
      </aside>
    ) : collapsedRail;
  }

  if (!isOpen) {
    return collapsedRail;
  }

  return (
    <aside
      className="sticky top-4 h-fit rounded-[28px] border border-border/60 bg-card/75 p-4 shadow-sm backdrop-blur-xl"
      data-testid="article-outline-panel"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ListTree size={15} />
            Outline
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {headings.length} section{headings.length === 1 ? '' : 's'}
          </p>
        </div>

        <button
          onClick={onToggle}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          aria-label="Hide outline"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-foreground/8">
        <m.div
          className="h-full rounded-full bg-primary"
          style={{ width: `${readingProgress}%` }}
          transition={{ duration: 0.12 }}
        />
      </div>

      <nav aria-label="Article outline">
        <ul className="space-y-1">
          {tree.map((node) => (
            <OutlineItem
              key={node.heading.id}
              activeId={activeId}
              collapsedIds={collapsedIds}
              node={node}
              onNavigate={handleNavigate}
              onToggleCollapsed={handleToggleCollapsed}
            />
          ))}
        </ul>
      </nav>

      {pageId ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl bg-foreground/4 px-3 py-2 text-xs text-muted-foreground">
          <ChevronDown size={12} className="text-primary/70" />
          Synced to article {pageId}
        </div>
      ) : null}
    </aside>
  );
}
