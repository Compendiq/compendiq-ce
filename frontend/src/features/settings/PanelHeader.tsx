import type { ReactNode } from 'react';

interface PanelHeaderProps {
  /** One-sentence description under the page H1. */
  subtitle?: ReactNode;
  /** Optional right-aligned action slot (single CTA, status pill, etc.). */
  action?: ReactNode;
}

/**
 * Lead-in strip for a settings panel. The page H1 already names the
 * panel (`Settings · {label}`), so this is subtitle + optional action —
 * not a second title.
 */
export function PanelHeader({ subtitle, action }: PanelHeaderProps) {
  if (!subtitle && !action) return null;

  return (
    <header className="mb-6 flex items-start justify-between gap-4 border-b border-border pb-4">
      {subtitle && (
        <p className="min-w-0 text-sm text-muted-foreground">{subtitle}</p>
      )}
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
