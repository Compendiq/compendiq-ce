import type { ReactNode } from 'react';

interface PanelHeaderProps {
  /** Primary panel name — e.g., "AI Models". Renders as the section H2. */
  title: string;
  /** One-sentence description shown directly under the title. */
  subtitle?: ReactNode;
  /** Optional right-aligned action slot (single CTA, status pill, etc.). */
  action?: ReactNode;
}

/**
 * Consistent header strip for every settings panel. Used inside the wrapper
 * card so the user always sees: WHICH panel they're in + a one-line reason
 * to be here. The wrapping `<SettingsLayout>` already renders the page-level
 * "Settings" H1, so this is a deliberate H2 — second tier, not duplicate.
 *
 * The thin honey rule under the title reclaims the brand accent in a
 * structural place (vs. floating in CTAs) — a small touch that ties the
 * page back to the Compendiq palette without becoming decorative noise.
 */
export function PanelHeader({ title, subtitle, action }: PanelHeaderProps) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4 border-b border-border/40 pb-4">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        {/* 2px honey underline tick — 24px wide, sits 6px below the title. */}
        <div
          aria-hidden="true"
          className="mt-1.5 h-[2px] w-6 rounded-full bg-[var(--color-primary-ink)]"
        />
        {subtitle && (
          <p className="mt-3 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
