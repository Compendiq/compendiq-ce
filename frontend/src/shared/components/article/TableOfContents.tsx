import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { m } from 'framer-motion';
import { List, X, ChevronDown, ChevronRight } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { cn } from '../../lib/cn';

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

interface TocNode {
  heading: TocHeading;
  children: TocNode[];
}

interface TableOfContentsProps {
  /** Raw HTML content to parse headings from (legacy mode) */
  htmlContent?: string;
  /** Pre-parsed headings list (preferred, from ArticleViewer) */
  headings?: TocHeading[];
  contentRef?: React.RefObject<HTMLElement | null>;
  /** Article ID used to persist per-page collapse state in localStorage */
  pageId?: string;
}

// ---------- Utilities ----------

export function parseHeadings(html: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const elements = doc.querySelectorAll('h1, h2, h3, h4');

  elements.forEach((el, i) => {
    const level = parseInt(el.tagName[1], 10);
    const text = el.textContent?.trim() || '';
    const id = el.id || `heading-${i}`;
    if (text) {
      headings.push({ id, text, level });
    }
  });

  return headings;
}

export function buildTree(headings: TocHeading[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: TocNode[] = [];

  for (const heading of headings) {
    const node: TocNode = { heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return root;
}

/** Returns IDs of all ancestors of targetId in the tree, or null if not found. */
function findAncestorIds(tree: TocNode[], targetId: string): string[] | null {
  for (const node of tree) {
    if (node.heading.id === targetId) return [];
    const result = findAncestorIds(node.children, targetId);
    if (result !== null) return [node.heading.id, ...result];
  }
  return null;
}

function readPanelOpen(): boolean {
  try {
    const v = localStorage.getItem('toc-panel-open');
    return v !== null ? v === 'true' : true;
  } catch {
    return true;
  }
}

function readCollapsedIds(storageKey: string): Set<string> {
  try {
    const v = localStorage.getItem(storageKey);
    return v ? new Set(JSON.parse(v) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

// ---------- TocNodeItem ----------

interface TocNodeItemProps {
  node: TocNode;
  activeId: string | null;
  collapsedIds: Set<string>;
  onToggleCollapsed: (id: string) => void;
  scrollToHeading: (id: string) => void;
}

function TocNodeItem({ node, activeId, collapsedIds, onToggleCollapsed, scrollToHeading }: TocNodeItemProps) {
  const { heading, children } = node;
  const hasChildren = children.length > 0;
  const isOpen = !collapsedIds.has(heading.id);
  const isActive = activeId === heading.id;

  return (
    <li>
      <Collapsible.Root open={isOpen} onOpenChange={() => onToggleCollapsed(heading.id)}>
        <div className="flex items-center">
          {hasChildren ? (
            <Collapsible.Trigger asChild>
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                aria-label={isOpen ? 'Collapse section' : 'Expand section'}
                data-testid={`toc-toggle-${heading.id}`}
              >
                <ChevronRight
                  size={12}
                  className={cn('transition-transform duration-150', isOpen && 'rotate-90')}
                />
              </button>
            </Collapsible.Trigger>
          ) : (
            <span className="w-[20px] shrink-0" />
          )}
          <button
            onClick={() => scrollToHeading(heading.id)}
            className={cn(
              'flex-1 truncate rounded-md px-2 py-1 text-left text-sm transition-colors',
              heading.level === 1 && 'font-medium',
              heading.level === 2 && 'pl-4',
              heading.level === 3 && 'pl-6 text-xs',
              heading.level === 4 && 'pl-8 text-xs',
              isActive
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            {heading.text}
          </button>
        </div>
        {hasChildren && (
          <Collapsible.Content className="toc-collapsible-content">
            <ul className="space-y-0.5">
              {children.map((child) => (
                <TocNodeItem
                  key={child.heading.id}
                  node={child}
                  activeId={activeId}
                  collapsedIds={collapsedIds}
                  onToggleCollapsed={onToggleCollapsed}
                  scrollToHeading={scrollToHeading}
                />
              ))}
            </ul>
          </Collapsible.Content>
        )}
      </Collapsible.Root>
    </li>
  );
}

// ---------- TableOfContents ----------

export function TableOfContents({ htmlContent, headings: headingsProp, contentRef, pageId }: TableOfContentsProps) {
  const storageKey = `toc-collapsed-${pageId ?? 'default'}`;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [readingProgress, setReadingProgress] = useState(0);
  const [panelOpen, setPanelOpen] = useState(readPanelOpen);
  const [collapsedIds, setCollapsedIds] = useState(() => readCollapsedIds(storageKey));
  const observerRef = useRef<IntersectionObserver | null>(null);

  const parsedHeadings = useMemo(() => (htmlContent ? parseHeadings(htmlContent) : []), [htmlContent]);
  const headings = headingsProp ?? parsedHeadings;
  const tree = useMemo(() => buildTree(headings), [headings]);

  // Persist panel state globally
  useEffect(() => {
    try { localStorage.setItem('toc-panel-open', String(panelOpen)); } catch { /* ignore */ }
  }, [panelOpen]);

  // Persist collapsed sections per page
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify([...collapsedIds])); } catch { /* ignore */ }
  }, [collapsedIds, storageKey]);

  // Reset collapsed state when navigating to a different article (storageKey change)
  useEffect(() => {
    setCollapsedIds(readCollapsedIds(storageKey));
  }, [storageKey]);

  // Scroll tracking via IntersectionObserver
  useEffect(() => {
    if (!contentRef?.current || headings.length === 0) return;

    const headingElements = headings
      .map((h) => contentRef.current?.querySelector(`#${CSS.escape(h.id)}`))
      .filter(Boolean) as Element[];

    if (headingElements.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-10% 0% -80% 0%', threshold: 0 },
    );

    headingElements.forEach((el) => observerRef.current?.observe(el));
    return () => observerRef.current?.disconnect();
  }, [headings, contentRef]);

  // Auto-expand any collapsed ancestors when the active heading changes
  useEffect(() => {
    if (!activeId) return;
    const ancestorIds = findAncestorIds(tree, activeId);
    if (!ancestorIds || ancestorIds.length === 0) return;
    setCollapsedIds((prev) => {
      if (!ancestorIds.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      ancestorIds.forEach((id) => next.delete(id));
      return next;
    });
  }, [activeId, tree]);

  // Reading progress — listen on the app's internal scroll container
  useEffect(() => {
    const container = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (!container) return;

    function handleScroll() {
      const scrollHeight = container!.scrollHeight - container!.clientHeight;
      if (scrollHeight > 0) {
        setReadingProgress(Math.min(100, (container!.scrollTop / scrollHeight) * 100));
      }
    }

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }, []);

  const scrollToHeading = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
      setIsMobileOpen(false);
    }
  }, []);

  if (headings.length === 0) return null;

  return (
    <>
      {/* Reading progress bar */}
      <div className="fixed left-0 top-0 z-40 h-0.5 w-full" aria-hidden="true">
        <m.div
          className="h-full bg-primary"
          style={{ width: `${readingProgress}%` }}
          transition={{ duration: 0.1 }}
        />
      </div>

      {/* Mobile toggle */}
      <button
        onClick={() => setIsMobileOpen(!isMobileOpen)}
        className="fixed bottom-4 right-4 z-40 rounded-full bg-primary p-3 text-primary-foreground shadow-lg lg:hidden"
        aria-label="Toggle table of contents"
      >
        {isMobileOpen ? <X size={20} /> : <List size={20} />}
      </button>

      {/* Sidebar */}
      <div
        className={cn(
          'glass-card fixed right-0 top-0 z-30 h-full w-64 overflow-y-auto p-4 transition-transform duration-300 lg:sticky lg:top-6 lg:z-0 lg:h-fit lg:max-h-[calc(100vh-4rem)] lg:translate-x-0',
          isMobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
        )}
        role="navigation"
        aria-label="Table of contents"
      >
        {/* Header with panel fold toggle */}
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Table of Contents
          </h3>
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            aria-label={panelOpen ? 'Collapse outline' : 'Expand outline'}
            data-testid="toc-panel-toggle"
          >
            <ChevronDown
              size={14}
              className={cn('transition-transform duration-150', !panelOpen && '-rotate-90')}
            />
          </button>
        </div>

        {panelOpen && (
          <nav data-testid="toc-nav-content">
            <ul className="space-y-0.5">
              {tree.map((node) => (
                <TocNodeItem
                  key={node.heading.id}
                  node={node}
                  activeId={activeId}
                  collapsedIds={collapsedIds}
                  onToggleCollapsed={toggleCollapsed}
                  scrollToHeading={scrollToHeading}
                />
              ))}
            </ul>
          </nav>
        )}
      </div>
    </>
  );
}
