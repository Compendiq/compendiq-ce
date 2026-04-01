import { NodeViewWrapper } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../../lib/api';
import type { NodeViewProps } from '@tiptap/react';

interface ChildPage {
  id: number;
  confluenceId: string | null;
  title: string;
  spaceKey: string | null;
  children?: ChildPage[];
}

/**
 * React NodeView for the ConfluenceChildren TipTap node.
 *
 * Fetches the current page's child pages from the backend and renders
 * them as a nested list of clickable links. Supports sort, depth,
 * and reverse attributes from the Confluence children/ui-children macros.
 */
export function ChildrenMacroView({ node }: NodeViewProps) {
  const { id: pageId } = useParams<{ id: string }>();
  const [children, setChildren] = useState<ChildPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sort = node.attrs.sort || 'title';
  const depth = parseInt(node.attrs.depth || '1', 10);
  const reverse = node.attrs.reverse === 'true';

  useEffect(() => {
    if (!pageId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

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
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load children');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pageId, sort, depth, reverse]);

  function renderChildren(items: ChildPage[]) {
    return (
      <ul className="list-disc pl-4 space-y-1">
        {items.map((child) => (
          <li key={child.id}>
            <Link
              to={`/pages/${child.id}`}
              className="text-primary hover:underline"
            >
              {child.title}
            </Link>
            {child.children && child.children.length > 0
              ? renderChildren(child.children)
              : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <NodeViewWrapper
      className="confluence-children-view my-4 p-4 border border-border rounded-lg"
      data-testid="children-macro-view"
    >
      <div
        className="text-sm font-medium text-muted-foreground mb-2"
        contentEditable={false}
      >
        Child Pages
      </div>
      {loading ? (
        <div className="animate-pulse space-y-2" data-testid="children-loading">
          <div className="h-4 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-36" />
          <div className="h-4 bg-muted rounded w-52" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive italic" data-testid="children-error">
          {error}
        </p>
      ) : children.length > 0 ? (
        <div data-testid="children-list">{renderChildren(children)}</div>
      ) : (
        <p
          className="text-sm text-muted-foreground italic"
          data-testid="children-empty"
        >
          No child pages
        </p>
      )}
    </NodeViewWrapper>
  );
}
