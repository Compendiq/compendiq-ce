import { useCallback, useEffect, useMemo, useState } from 'react';
import { diffWords } from 'diff';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAiContext } from '../AiContext';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { improveMarkdownToHtml } from '../../../shared/components/article/improve-markdown';
import { isMac as detectMac } from '../../../shared/lib/platform';
import { cn } from '../../../shared/lib/cn';
import type { DockChipId } from './dock-chips';

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

/**
 * Why the diff can no longer be applied as-proposed.
 *
 * `moved` is the dangerous one: the published page gained a new version after
 * the model was shown the old one, so applying would silently discard whatever
 * that revision contained. `unsaved` is recoverable — the editor holds work the
 * assistant never saw, but TipTap history makes replacing it undoable, so we
 * name the consequence instead of blocking.
 */
type DiffStaleness = 'moved' | 'unsaved' | null;

/**
 * The pending improvement, rendered inline in the dock thread (#1126).
 *
 * `DiffView` (used by `/ai` and version history) is a full-pane component: its
 * side-by-side mode is `md:grid-cols-2`, which cannot fit a 420px column, and
 * its Accept button is the high-contrast `--color-action` outline CTA rather
 * than the steel that means "operate this" under ADR-010 v0.5. This is the same
 * word-level `diffWords` computation in a shape that fits the dock.
 */
export function DockDiffCard({ onRerun }: { onRerun: (id: DockChipId) => void }) {
  const {
    page, isStreaming, showDiffView, setShowDiffView,
    improvedContent, originalMarkdown, layoutTokensLost: backendLayoutTokensLost,
    diffBaseVersion,
  } = useAiContext();

  const editing = useArticleViewStore((s) => s.editing);
  const editorDirty = useArticleViewStore((s) => s.editorDirty);
  const requestEdit = useArticleViewStore((s) => s.requestEdit);
  const applyContent = useArticleViewStore((s) => s.applyContent);

  // Armed while we have asked the article to open its editor and are waiting.
  // `requestEdit` can defer indefinitely — PageViewPage puts a "Restore draft?"
  // dialog in the way when a local draft diverges from the published body, and
  // the user may dismiss it and never enter edit mode. That is why this state
  // is cancellable rather than a spinner that can never resolve.
  const [awaitingEditor, setAwaitingEditor] = useState(false);

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

  const apply = useCallback(() => {
    if (!improvedContent) return 'no-editor' as const;
    const result = applyContent?.(improveMarkdownToHtml(improvedContent)) ?? 'no-editor';
    if (result === 'applied') {
      setShowDiffView(false);
      toast.success('Applied to the editor. Save to publish the change.');
    }
    return result;
  }, [improvedContent, applyContent, setShowDiffView]);

  // Perform the deferred apply once the editor actually exists. Both conditions
  // matter and they do not arrive together: `editing` flips first, then the
  // Editor mounts and registers `applyContent` an effect later.
  useEffect(() => {
    if (!awaitingEditor || !editing || !applyContent) return;
    setAwaitingEditor(false);
    apply();
  }, [awaitingEditor, editing, applyContent, apply]);

  if (!showDiffView || !page || !improvedContent || isStreaming) return null;

  // The page's markdown carried [[[…]]] layout boundary tokens but the AI output
  // lost every one of them. The backend's final-event verdict is authoritative
  // (it runs the real recoverability scan); the `[[[` heuristic only covers
  // streams that ended without a final event.
  const layoutTokensLost =
    backendLayoutTokensLost ??
    (/\[\[\[/.test(originalMarkdown) && !/\[\[\[/.test(improvedContent));

  const staleness: DiffStaleness =
    diffBaseVersion !== null && page.version !== diffBaseVersion
      ? 'moved'
      : editorDirty
        ? 'unsaved'
        : null;

  const undoKey = detectMac() ? '⌘Z' : 'Ctrl+Z';

  const handleApply = () => {
    if (apply() === 'applied') return;
    // Read mode: there is no editor to write into, so ask for one instead of
    // failing. The effect above finishes the job when it arrives.
    setAwaitingEditor(true);
    requestEdit?.();
  };

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

      {layoutTokensLost && (
        <p
          data-testid="layout-token-loss-warning"
          role="alert"
          className="border-t border-border/50 bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          This response dropped the page’s column-layout markers. Applying would flatten the layout — run Improve again to retry.
        </p>
      )}

      {staleness === 'moved' && (
        <p className="border-t border-border/50 bg-warning/10 px-3 py-2 text-xs text-foreground" data-testid="dock-diff-stale">
          This page reached v{page.version} after these changes were proposed. Re-run Improve so it works from the current text.
        </p>
      )}
      {staleness === 'unsaved' && (
        <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground" data-testid="dock-diff-unsaved">
          The editor has unsaved changes the assistant has not seen. Applying replaces them; {undoKey} brings them back.
        </p>
      )}
      {awaitingEditor && (
        <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground" role="status" data-testid="dock-diff-awaiting-editor">
          Waiting for the editor to open.
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2.5">
        {awaitingEditor ? (
          <>
            <button type="button" onClick={() => setAwaitingEditor(false)} className="nm-button-ghost text-sm">
              Cancel
            </button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" aria-hidden /> Opening editor
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowDiffView(false)}
              className="nm-button-ghost text-sm"
              data-testid="dock-diff-skip"
            >
              <X size={14} aria-hidden /> Skip
            </button>
            {staleness === 'moved' ? (
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
                onClick={handleApply}
                className="nm-button-primary text-sm"
                data-testid="dock-diff-apply"
                title={editing
                  ? 'Write these changes into the editor. Nothing is published until you save.'
                  : 'Open the editor and write these changes into it. Nothing is published until you save.'}
              >
                <Check size={14} aria-hidden /> {editing ? 'Apply' : 'Edit & apply'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
