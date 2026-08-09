import { cn } from '../../lib/cn';
import { TOOLBAR_ITEM_ATTR } from './use-toolbar-roving-focus';

/**
 * The shared box vocabulary for the editor's toolbars — the main one above the
 * document and the three context strips (table / layout / column) that appear
 * beneath it.
 *
 * These used to be private to `Editor.tsx` and hand-rolled: a 28px box built
 * from `p-1.5`, with no `focus-visible` treatment at all across 101 call sites.
 * They are now `nm-icon-button`, which is the app's 32px control — the same
 * height as every button, input and select in the workspace, per ADR-010's
 * density rule — and which already carries hover, active, disabled, the
 * `--color-ring` focus outline, and the pressed state.
 */

export function ToolbarButton({
  onClick,
  active,
  disabled,
  children,
  title,
  label,
  testId,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  /** Tooltip text. Also the accessible name unless `label` overrides it. */
  title: string;
  /**
   * Accessible name, when the tooltip is not the right thing to announce.
   * Icon-only controls carry a real `aria-label` rather than leaning on `title`:
   * `title` is only the *last* fallback in the accessible-name computation, it
   * is not exposed by every screen reader, and it never appears on touch.
   */
  label?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      {...{ [TOOLBAR_ITEM_ATTR]: '' }}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label ?? title}
      aria-pressed={active}
      className="nm-icon-button"
    >
      {children}
    </button>
  );
}

export function ToolbarSeparator() {
  // Hidden below `sm`, where the bar wraps: a divider that lands at the end of
  // a wrapped row separates a group from nothing. The container opens its
  // horizontal gap at those widths so the grouping still reads.
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="mx-1 hidden h-5 w-px bg-border sm:block"
    />
  );
}

export function ToolbarGroup({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={name}
      data-testid={`toolbar-group-${name}`}
      className="flex items-center gap-0.5"
    >
      {children}
    </div>
  );
}

/**
 * The column-proportion glyph used by the layout preset picker and the column
 * context strip. Drawn from the preset's own `bars` array, so a new preset
 * cannot ship with a diagram of a different layout.
 */
export function LayoutPreview({
  bars,
  size = 'sm',
  className,
}: {
  bars: readonly number[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      className={cn('flex gap-0.5', size === 'sm' ? 'h-4 w-10' : 'h-5 w-12', className)}
      aria-hidden
    >
      {bars.map((flex, i) => (
        <div key={i} style={{ flex }} className="rounded-[2px] bg-current opacity-25" />
      ))}
    </div>
  );
}
