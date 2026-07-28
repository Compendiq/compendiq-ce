import { useCallback, useMemo, useState } from 'react';
import { diffWords } from 'diff';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAiContext } from '../AiContext';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { apiFetch, ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import type { DockChipId } from './dock-chips';

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/** A rejected apply, kept on screen instead of vanishing with a toast. */
interface ApplyFailure {
  message: string;
  /** 409 / 422 — the page is unchanged and re-running is the way forward. */
  rerunnable: boolean;
}

/**
 * The pending improvement, rendered inline in the dock thread (#1126).
 *
 * `DiffView` (used by `/ai` and version history) is a full-pane component: its
 * side-by-side mode is `md:grid-cols-2`, which cannot fit a 420px column, and
 * its Accept button is the high-contrast `--color-action` outline CTA rather
 * than the steel that means "operate this" under ADR-010 v0.5. This is the same
 * word-level `diffWords` computation in a shape that fits the dock.
 *
 * ── Why Apply is a server round-trip and not a write into the editor ────────
 *
 * The design sketch called for `Apply` to write straight into TipTap. It does
 * not, and the reason is data loss rather than convenience.
 *
 * `POST /llm/improvements/apply` is not merely persistence. Before it writes it
 * runs `protectMedia` / `restoreMedia` (#723) — re-deriving media tokens from
 * the page's *current* `body_html` and re-injecting images and draw.io diagrams
 * verbatim, with a drop-guard that re-appends anything the model lost — and
 * `extractLayoutSkeleton` + `markdownToHtml(…, { layoutSkeleton })` (#781),
 * which realigns column-layout boundary tokens and **rejects the apply with a
 * 422** when the layout cannot be recovered, leaving the page untouched.
 *
 * All of that lives in `backend/src/core/services/content-converter.ts`: 2145
 * lines built on JSDOM and turndown, with its own media and layout test suites,
 * and no frontend counterpart. A client-side `marked` + DOMPurify round-trip
 * reproduces none of it. Applying that way would silently strip Confluence
 * macros and media into the editor, where the next Save would push the
 * flattened body upstream — a loss the user has no reason to look for, and one
 * that undo cannot help with if it is never noticed.
 *
 * So the persistence mechanism stays server-side and keeps every guard. What
 * the dock changes is where the decision happens: the diff sits inline in the
 * thread beside the document it describes, instead of on a mode screen at a
 * route that hid that document from view.
 *
 * The consequence to know about: this rewrites the *saved* page, so it is
 * unavailable while the editor is open — see `editing` below.
 */
export function DockDiffCard({ onRerun }: { onRerun: (id: DockChipId) => void }) {
  const {
    page, pageId, queryClient, isStreaming, showDiffView, setShowDiffView,
    improvedContent, originalMarkdown, layoutTokensLost: backendLayoutTokensLost,
    diffBaseVersion,
  } = useAiContext();

  const editing = useArticleViewStore((s) => s.editing);

  const [isApplying, setIsApplying] = useState(false);
  const [failure, setFailure] = useState<ApplyFailure | null>(null);

  const diff = useMemo(
    () => (improvedContent ? (diffWords(originalMarkdown || page?.bodyText || '', improvedContent) as DiffPart[]) : []),
    [originalMarkdown, improvedContent, page?.bodyText],
  );

  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const part of diff) {
      if (part.added) additions += part.value.length;
      if (part.removed) deletions += part.value.length;
    }
    return { additions, deletions };
  }, [diff]);

  const handleApply = useCallback(async () => {
    if (!page || !pageId || !improvedContent || isApplying) return;
    setIsApplying(true);
    setFailure(null);
    try {
      await apiFetch('/llm/improvements/apply', {
        method: 'POST',
        body: JSON.stringify({
          pageId,
          improvedMarkdown: improvedContent,
          version: page.version,
          title: page.title,
        }),
      });
      toast.success('Page updated and synced to Confluence');
      // No navigation, unlike /ai's Accept: the document is already on screen,
      // so invalidating is enough for the reader to watch it change in place.
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
      setShowDiffView(false);
    } catch (err) {
      const status = err instanceof ApiError ? err.statusCode : undefined;
      const message = err instanceof Error ? err.message : 'Failed to apply the change.';
      // 409 (the page moved) and 422 (#781 — the response lost the column
      // layout beyond recovery) both mean the page was NOT modified. They stay
      // on the card rather than in a toast, because the recovery from them is a
      // decision the user makes right here.
      const rerunnable = status === 409 || status === 422;
      setFailure({ message, rerunnable });
      if (!rerunnable) toast.error(message);
    } finally {
      setIsApplying(false);
    }
  }, [page, pageId, improvedContent, isApplying, queryClient, setShowDiffView]);

  if (!showDiffView || !page || !improvedContent || isStreaming) return null;

  // The page's markdown carried [[[…]]] layout boundary tokens but the AI output
  // lost every one of them, so the backend's layout guard will most likely
  // reject this (422). Surface it BEFORE the user commits to applying. The
  // backend's final-event verdict is authoritative (it runs the real
  // recoverability scan, which also recognizes mangled token spellings); the
  // `[[[` heuristic only covers streams that ended without a final event.
  const layoutTokensLost =
    backendLayoutTokensLost ??
    (/\[\[\[/.test(originalMarkdown) && !/\[\[\[/.test(improvedContent));

  const moved = diffBaseVersion !== null && page.version !== diffBaseVersion;
  const rerunOnly = moved || failure?.rerunnable === true;

  return (
    <div className="nm-card overflow-hidden" data-testid="dock-diff-card">
      <div className="flex items-baseline justify-between gap-3 border-b border-border/50 px-3 py-2">
        <h3 className="text-sm font-medium text-foreground">Proposed changes</h3>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-success">+{stats.additions}</span>{' '}
          <span className="text-destructive">−{stats.deletions}</span>
        </span>
      </div>

      <div className="max-h-[40vh] overflow-auto px-3 py-2.5">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed" data-testid="dock-unified-diff">
          {diff.map((part, i) => (
            <span
              key={i}
              className={cn(
                part.added && 'bg-success/20 text-success',
                part.removed && 'bg-destructive/20 text-destructive line-through',
              )}
            >
              {part.value}
            </span>
          ))}
        </pre>
      </div>

      {layoutTokensLost && !failure && (
        <p
          data-testid="layout-token-loss-warning"
          role="alert"
          className="border-t border-border/50 bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          This response dropped the page’s column-layout markers, so applying will most likely be
          rejected. Run Improve again to retry.
        </p>
      )}

      {failure && (
        <p
          data-testid="dock-diff-apply-error"
          role="alert"
          className="border-t border-border/50 bg-destructive/10 px-3 py-2 text-xs text-foreground"
        >
          {failure.message}
        </p>
      )}

      {moved && !failure && (
        <p className="border-t border-border/50 bg-warning/10 px-3 py-2 text-xs text-foreground" data-testid="dock-diff-stale">
          This page reached v{page.version} after these changes were proposed. Re-run Improve so it
          works from the current text.
        </p>
      )}

      {/* Apply rewrites the SAVED page, so an open editor would hold its own
          stale copy and overwrite the improvement on the next save. */}
      {editing && !rerunOnly && (
        <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground" data-testid="dock-diff-editing">
          Applying updates the saved page. Save or cancel your edit first.
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setShowDiffView(false)}
          className="nm-button-ghost text-sm"
          data-testid="dock-diff-skip"
        >
          <X size={14} aria-hidden /> Skip
        </button>
        {rerunOnly ? (
          <button
            type="button"
            onClick={() => { setShowDiffView(false); onRerun('improve'); }}
            className="nm-button-primary text-sm"
            data-testid="dock-diff-rerun"
          >
            <RotateCcw size={14} aria-hidden /> Re-run Improve
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={isApplying || editing}
            className="nm-button-primary text-sm"
            data-testid="dock-diff-apply"
            title={editing
              ? 'Unavailable while you are editing — this rewrites the saved page.'
              : 'Rewrite the page with these changes and sync it to Confluence.'}
          >
            {isApplying
              ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Applying…</>
              : <><Check size={14} aria-hidden /> Apply</>}
          </button>
        )}
      </div>
    </div>
  );
}
