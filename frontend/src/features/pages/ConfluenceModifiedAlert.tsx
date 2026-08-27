/**
 * Honest refusal when Confluence moved while a collab session is live (#1448).
 * `role="status"` (not alert) so AT is not interrupted; the session stays open.
 */
import { cn } from '../../shared/lib/cn';

export function ConfluenceModifiedAlert({
  remoteVersion,
  localVersion,
  onDismiss,
  className,
}: {
  remoteVersion?: number;
  localVersion?: number;
  onDismiss: () => void;
  className?: string;
}) {
  const versions =
    typeof remoteVersion === 'number' && typeof localVersion === 'number'
      ? ` (remote version ${remoteVersion}, local version ${localVersion})`
      : '';

  return (
    <div
      role="status"
      data-testid="confluence-modified-alert"
      className={cn(
        'flex items-start gap-3 border-b border-border bg-background px-5 py-2.5 text-sm text-muted-foreground',
        className,
      )}
    >
      <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-border bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
        Not saved
      </span>
      <p className="min-w-0 flex-1 leading-5 text-foreground">
        This page was modified in Confluence{versions}. Your collaborative
        session is still open — nobody&apos;s edits were overwritten.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="nm-button-ghost h-8 shrink-0 px-2 text-xs"
      >
        Dismiss
      </button>
    </div>
  );
}
