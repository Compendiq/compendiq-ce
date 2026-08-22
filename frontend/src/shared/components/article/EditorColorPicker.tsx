import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Baseline } from 'lucide-react';
import { cn } from '../../lib/cn';
import { TOOLBAR_ITEM_ATTR } from './use-toolbar-roving-focus';

/**
 * Text colour and highlight share one palette. The eight original hexes stay
 * so existing marks still read as selected; Brown and Teal fill the two
 * gaps against the Notion / Plane row (grey → brown → warm → cool → red).
 */
export const PRESET_COLORS = [
  { label: 'Grey', value: '#6b7280' },
  { label: 'Brown', value: '#b45309' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Teal', value: '#0d9488' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Red', value: '#ef4444' },
] as const;

const SWATCH_BUTTON =
  'flex size-6 items-center justify-center rounded-full border outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring';

function ColorRow({
  label,
  kind,
  activeColor,
  onSelect,
  onReset,
  onDone,
}: {
  label: string;
  kind: 'text' | 'highlight';
  activeColor: string | undefined;
  onSelect: (color: string) => void;
  onReset: () => void;
  onDone: () => void;
}) {
  const defaultLabel = `Default ${label.toLowerCase()}`;
  return (
    <div>
      <p className="px-0.5 pb-1.5 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="grid grid-cols-6 gap-1" role="group" aria-label={label}>
        <button
          type="button"
          title={defaultLabel}
          aria-label={defaultLabel}
          aria-pressed={!activeColor}
          onClick={() => {
            onReset();
            onDone();
          }}
          className={cn(
            SWATCH_BUTTON,
            !activeColor ? 'border-foreground' : 'border-border',
            kind === 'highlight' && 'bg-background',
          )}
        >
          {kind === 'text' ? (
            <span className="text-[11px] font-semibold text-muted-foreground">A</span>
          ) : (
            <span aria-hidden className="relative block size-3">
              <span className="absolute inset-0 rounded-full border border-muted-foreground/70" />
              <span className="absolute inset-x-0 top-1/2 h-px -rotate-45 bg-muted-foreground" />
            </span>
          )}
        </button>
        {PRESET_COLORS.map((c) => {
          const selected = activeColor === c.value;
          const swatchLabel = `${c.label} ${kind === 'text' ? 'text' : 'highlight'}`;
          return (
            <button
              key={`${kind}-${c.value}`}
              type="button"
              title={swatchLabel}
              aria-label={swatchLabel}
              aria-pressed={selected}
              data-testid="color-picker-swatch"
              onClick={() => {
                onSelect(c.value);
                onDone();
              }}
              className={cn(SWATCH_BUTTON, selected ? 'border-foreground' : 'border-border')}
              style={kind === 'highlight' ? { backgroundColor: c.value } : undefined}
            >
              {kind === 'text' && (
                <span className="text-[11px] font-semibold" style={{ color: c.value }}>
                  A
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ColorPanel({
  textColor,
  highlightColor,
  onSelectText,
  onResetText,
  onSelectHighlight,
  onResetHighlight,
  onDone,
}: {
  textColor: string | undefined;
  highlightColor: string | undefined;
  onSelectText: (color: string) => void;
  onResetText: () => void;
  onSelectHighlight: (color: string) => void;
  onResetHighlight: () => void;
  onDone: () => void;
}) {
  return (
    <div className="flex w-[11.5rem] flex-col gap-2.5">
      <ColorRow
        label="Color"
        kind="text"
        activeColor={textColor}
        onSelect={onSelectText}
        onReset={onResetText}
        onDone={onDone}
      />
      <ColorRow
        label="Highlight"
        kind="highlight"
        activeColor={highlightColor}
        onSelect={onSelectHighlight}
        onReset={onResetHighlight}
        onDone={onDone}
      />
    </div>
  );
}

/**
 * One Color control, not two. Notion and Plane put text colour and highlight
 * in the same panel so the author picks a hue, then a role, without hunting
 * for a second trigger.
 */
export function ColorPickerDropdown({
  textColor,
  highlightColor,
  onSelectText,
  onResetText,
  onSelectHighlight,
  onResetHighlight,
}: {
  textColor: string | undefined;
  highlightColor: string | undefined;
  onSelectText: (color: string) => void;
  onResetText: () => void;
  onSelectHighlight: (color: string) => void;
  onResetHighlight: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          {...{ [TOOLBAR_ITEM_ATTR]: '' }}
          title="Color"
          aria-label="Color"
          aria-haspopup="dialog"
          data-testid="color-picker-trigger"
          className="nm-icon-button"
        >
          <span className="relative flex items-center justify-center">
            <span
              className="flex items-center justify-center rounded-[3px] px-px"
              style={{ backgroundColor: highlightColor || undefined }}
            >
              <Baseline size={15} style={textColor ? { color: textColor } : undefined} />
            </span>
            {textColor && (
              <span
                aria-hidden
                className="absolute -bottom-1.5 left-0 right-0 h-[3px] rounded-full"
                style={{ backgroundColor: textColor }}
              />
            )}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="Color swatches"
          className="z-50 nm-card-elevated p-2.5 outline-none"
        >
          <ColorPanel
            textColor={textColor}
            highlightColor={highlightColor}
            onSelectText={onSelectText}
            onResetText={onResetText}
            onSelectHighlight={onSelectHighlight}
            onResetHighlight={onResetHighlight}
            onDone={() => setOpen(false)}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
