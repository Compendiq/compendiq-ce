import { useCallback, useRef, useState } from 'react';
import { Sparkles, Loader2, Check, ArrowDownToLine, RotateCcw, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { SanitizedHtml } from '../SanitizedHtml';
import { buildImproveHtml } from './improve-markdown';
import { QUICK_ACTIONS, type QuickAction } from './improve-actions';
import type { UseImproveStreamResult } from './use-improve-stream';

/**
 * #708 / #1179 — the inline "Improve with AI" section: free-form instruction,
 * quick actions, streamed preview and the accept controls.
 *
 * Shared verbatim by the selection bubble menu and the block context menu.
 * Everything that differs between the two — what text is sent, what a Replace
 * writes back, how the surrounding panel is dismissed — is the host's job and
 * arrives through callbacks. The panel itself owns only the free-form text and
 * the "what did we last run" memory that "Try again" replays.
 *
 * The panel never mutates the document: `onReplace` / `onInsertBelow` fire only
 * when the user asks, which is #716's "document is never mutated until accept"
 * guarantee.
 */

export interface ImprovePanelCopy {
  /** Accessible name of the section. */
  ariaLabel: string;
  placeholder: string;
  inputLabel: string;
  replaceTitle: string;
  insertTitle: string;
  /** Shown in the preview area until the first chunk arrives. */
  pendingLabel: string;
}

export function ImprovePanel({
  id,
  testIdPrefix,
  copy,
  stream,
  onRun,
  onReplace,
  onInsertBelow,
  onClose,
  className,
}: {
  id?: string;
  /** Prefix for the `-panel` / `-preview` / `-empty` test ids. */
  testIdPrefix: string;
  copy: ImprovePanelCopy;
  stream: UseImproveStreamResult;
  onRun: (action: QuickAction, freeForm: string) => void;
  onReplace: () => void;
  onInsertBelow: () => void;
  onClose: () => void;
  className?: string;
}) {
  const [freeForm, setFreeForm] = useState('');
  // The action + free-form text of the most recent run, captured so "Try again"
  // replays the user's actual choice rather than a hardcoded default.
  const lastRunRef = useRef<{ action: QuickAction; freeForm: string } | null>(null);

  const run = useCallback((action: QuickAction, freeFormText: string) => {
    lastRunRef.current = { action, freeForm: freeFormText };
    onRun(action, freeFormText);
  }, [onRun]);

  const retry = useCallback(() => {
    const last = lastRunRef.current;
    if (last) run(last.action, last.freeForm);
    else run(QUICK_ACTIONS[0]!, freeForm);
  }, [run, freeForm]);

  const isStreaming = stream.status === 'streaming';
  const hasResult = stream.output.length > 0;
  // The stream finished but produced nothing — surface explicit feedback rather
  // than silently dropping back to the quick-action menu.
  const emptyResult = stream.status === 'done' && !hasResult;
  const { html: previewHtml } = buildImproveHtml(stream.output);

  return (
    <div
      id={id}
      role="group"
      aria-label={copy.ariaLabel}
      data-testid={`${testIdPrefix}-panel`}
      className={cn('border-t border-border p-3', className)}
    >
      {!hasResult && !isStreaming && !emptyResult && stream.status !== 'error' && (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={freeForm}
            autoFocus
            onChange={(e) => setFreeForm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && freeForm.trim()) {
                e.preventDefault();
                run(QUICK_ACTIONS[0]!, freeForm);
              }
            }}
            placeholder={copy.placeholder}
            aria-label={copy.inputLabel}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <div className="flex flex-col gap-0.5">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                onClick={() => run(action, freeForm)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Sparkles size={14} className="text-primary" />
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {(isStreaming || hasResult) && (
        <div className="flex flex-col gap-2">
          <div
            data-testid={`${testIdPrefix}-preview`}
            aria-live="polite"
            className={cn(
              'prose prose-sm max-h-56 max-w-none overflow-y-auto rounded-md border border-border/60 bg-background p-2 text-sm',
              isStreaming && !hasResult && 'motion-safe:animate-pulse',
            )}
          >
            {hasResult
              ? <SanitizedHtml html={previewHtml} />
              : <span className="text-muted-foreground">{copy.pendingLabel}</span>}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onReplace}
              disabled={!hasResult || isStreaming}
              title={copy.replaceTitle}
              className="flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Check size={13} /> Replace
            </button>
            <button
              type="button"
              onClick={onInsertBelow}
              disabled={!hasResult || isStreaming}
              title={copy.insertTitle}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ArrowDownToLine size={13} /> Insert below
            </button>
            <button
              type="button"
              onClick={retry}
              disabled={isStreaming}
              title="Try again"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCcw size={13} /> Try again
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Discard"
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <X size={13} /> Discard
            </button>
          </div>
        </div>
      )}

      {isStreaming && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 size={13} className="motion-safe:animate-spin" />
          Streaming…
        </div>
      )}

      {emptyResult && (
        <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-empty`}>
          <p className="text-sm text-muted-foreground" role="status">
            No changes returned. Try again or adjust your request.
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={retry}
              title="Try again"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCcw size={13} /> Try again
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Discard"
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <X size={13} /> Discard
            </button>
          </div>
        </div>
      )}

      {stream.status === 'error' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive" role="alert">{stream.error}</p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={retry}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCcw size={13} /> Try again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <X size={13} /> Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
