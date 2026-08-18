import { NodeViewWrapper } from '@tiptap/react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Columns2 } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { NodeViewProps } from '@tiptap/react';

interface ChildPage {
  id: number;
  confluenceId: string | null;
  title: string;
  spaceKey: string | null;
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
  const headingId = useId();
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
    const rowClass =
      'nm-focus-ring block min-w-0 rounded-md px-2 py-1.5 text-sm break-words';
    if (isEditable) {
      return (
        <span className={cn(rowClass, 'text-foreground')} title={child.title}>
          {child.title}
        </span>
      );
    }
    return (
      <Link
        to={`/pages/${child.id}`}
        className={cn(rowClass, 'hover:bg-muted hover:underline')}
        title={child.title}
      >
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
          split && 'grid grid-cols-1 gap-x-8 gap-y-0.5 sm:grid-cols-2',
          !split && 'flex flex-col gap-0.5',
          !root && 'mt-0.5 pl-3',
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
      aria-labelledby={headingId}
      aria-busy={loading || undefined}
    >
      <div
        className="mb-2 flex items-start justify-between gap-3"
        contentEditable={false}
      >
        <h3 id={headingId} className="text-sm font-semibold">
          Children of this page
        </h3>
        {isEditable && (
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
        )}
      </div>
      {isEditable ? (
        <p
          id={columnsHintId}
          className="text-muted-foreground mb-2 text-xs"
          data-testid="children-columns-hint"
        >
          Compendiq only. Confluence ignores this.
        </p>
      ) : null}
      {isEditable && unusedParams ? (
        <p
          className="text-muted-foreground mb-2 text-xs"
          data-testid="children-unused-params"
        >
          This list is always this page&apos;s children. A pinned parent, count,
          heading style, and excerpts from Confluence are not shown.
        </p>
      ) : null}
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
          <div className="h-8 bg-muted w-48 rounded-md" />
          <div className="h-8 bg-muted w-36 rounded-md" />
          <div className="h-8 bg-muted w-52 rounded-md" />
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
