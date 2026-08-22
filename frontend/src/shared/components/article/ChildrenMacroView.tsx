import { NodeViewWrapper } from '@tiptap/react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Columns2 } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { NodeViewProps } from '@tiptap/react';
import type { PageIcon } from '@compendiq/contracts';
import { PageIcon as PageIconMark } from '../page-icon/PageIcon';

interface ChildPage {
  id: number;
  confluenceId: string | null;
  title: string;
  spaceKey: string | null;
  icon?: PageIcon | null;
  children?: ChildPage[];
}

const UNUSED_CONFLUENCE_PARAMS = ['page', 'first', 'style', 'excerptType'] as const;

/** Compendiq-local display param: two-column directory vs a single stack. */
function isTwoColumnChildrenLayout(value: unknown): boolean {
  return value === '2' || value === 2;
}

function hasUnusedConfluenceParams(attrs: Record<string, unknown>): boolean {
  return UNUSED_CONFLUENCE_PARAMS.some((name) => {
    const value = attrs[name];
    return value != null && value !== '';
  });
}

/**
 * React NodeView for the ConfluenceChildren TipTap node.
 *
 * A document index of this page's children — heading plus rows, not a gadget
 * card. Supports sort, depth, reverse, and the Compendiq-local `columns`
 * display attribute. Confluence `page` / `first` / `style` / `excerptType`
 * are stored for round-trip and not rendered.
 */
export function ChildrenMacroView({ node, updateAttributes, editor }: NodeViewProps) {
  const { id: pageId } = useParams<{ id: string }>();
  const columnsHintId = useId();
  const [children, setChildren] = useState<ChildPage[]>([]);
  const [loading, setLoading] = useState(Boolean(pageId));
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const sort = node.attrs.sort || 'title';
  const depth = parseInt(node.attrs.depth || '1', 10);
  const reverse = node.attrs.reverse === 'true';
  const twoColumns = isTwoColumnChildrenLayout(node.attrs.columns);
  const isEditable = editor.isEditable;
  const unusedParams = hasUnusedConfluenceParams(node.attrs);

  useEffect(() => {
    if (!pageId) {
      setLoading(false);
      setError(null);
      setChildren([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const order = reverse ? 'desc' : 'asc';
    const sortParam = sort === 'creation' ? 'created_at' : 'title';

    apiFetch<{ children: ChildPage[] }>(
      `/pages/${pageId}/children?sort=${sortParam}&order=${order}&depth=${depth}`,
    )
      .then((data) => {
        if (!cancelled) {
          setChildren(data.children);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Couldn't load child pages.");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pageId, sort, depth, reverse, reloadToken]);

  const toggleColumns = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      updateAttributes({ columns: twoColumns ? null : '2' });
    },
    [twoColumns, updateAttributes],
  );

  function renderTitle(child: ChildPage) {
    // Same hover language as PagesPage / the page tree: a flat accent fill,
    // never a border, lift, or Steel. Padding is always on so the fill has
    // somewhere to land without a layout shift; `px-1.5` not `px-2` — the
    // latter is the old chrome row this directory was stripped of.
    const titleClass = cn(
      'nm-focus-ring flex min-w-0 w-full items-start gap-1.5 break-words rounded-md px-1.5 py-1 transition-colors duration-150',
      !isEditable && 'hover:bg-accent focus-visible:bg-accent',
    );
    const mark = child.icon ? (
      <PageIconMark icon={child.icon} pageId={child.id} size="row" className="mt-0.5" />
    ) : null;
    if (isEditable) {
      return (
        <span className={cn(titleClass, 'text-foreground')} title={child.title}>
          {mark}
          {child.title}
        </span>
      );
    }
    return (
      <Link
        to={`/pages/${child.id}`}
        className={cn(titleClass, 'children-directory-link')}
        title={child.title}
      >
        {mark}
        {child.title}
      </Link>
    );
  }

  function renderChildren(items: ChildPage[], { root }: { root: boolean }) {
    const split = root && twoColumns;
    return (
      <ul
        className={cn(
          'children-directory m-0 list-none p-0',
          split && 'grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2',
          !split && 'flex flex-col gap-1',
          !root && 'mt-1',
        )}
      >
        {items.map((child) => (
          <li key={child.id} className="min-w-0">
            {renderTitle(child)}
            {child.children && child.children.length > 0
              ? renderChildren(child.children, { root: false })
              : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <NodeViewWrapper
      className="confluence-children-view my-4"
      data-testid="children-macro-view"
      data-columns={twoColumns ? '2' : '1'}
      aria-label="Child pages"
      aria-busy={loading || undefined}
    >
      {isEditable && (
        <div
          className="mb-2 flex flex-wrap items-center justify-between gap-2"
          contentEditable={false}
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={cn(
                'nm-focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium',
                twoColumns
                  ? 'border-border-interactive bg-background text-foreground border'
                  : 'hover:bg-muted hover:text-foreground border border-transparent text-muted-foreground',
              )}
              aria-pressed={twoColumns}
              aria-describedby={columnsHintId}
              data-testid="children-columns-toggle"
              onClick={toggleColumns}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <Columns2 size={14} aria-hidden />
              Two columns
            </button>
            <p
              id={columnsHintId}
              className="text-muted-foreground text-xs"
              data-testid="children-columns-hint"
            >
              Compendiq only. Confluence ignores this.
            </p>
          </div>
          {unusedParams && (
            <p
              className="text-muted-foreground basis-full text-xs"
              data-testid="children-unused-params"
            >
              This list is always this page&apos;s children. A pinned parent, count,
              heading style, and excerpts from Confluence are not shown.
            </p>
          )}
        </div>
      )}
      {loading ? (
        <div
          className={cn(
            'motion-reduce:animate-none animate-pulse',
            twoColumns
              ? 'grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2'
              : 'space-y-2',
          )}
          data-testid="children-loading"
        >
          <span className="sr-only">Loading child pages</span>
          <div className="bg-muted h-4 w-48" />
          <div className="bg-muted h-4 w-36" />
          <div className="bg-muted h-4 w-52" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="children-error">
          <p className="text-sm" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="nm-focus-ring text-sm font-medium underline underline-offset-2"
            onClick={() => setReloadToken((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      ) : children.length > 0 ? (
        <div data-testid="children-list">{renderChildren(children, { root: true })}</div>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="children-empty">
          {pageId ? 'This page has no children' : 'Child pages will appear on a saved page.'}
        </p>
      )}
    </NodeViewWrapper>
  );
}
