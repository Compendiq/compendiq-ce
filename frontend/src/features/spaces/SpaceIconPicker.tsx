import { SPACE_ICONS } from '../../shared/components/spaces/space-icons';

interface SpaceIconPickerProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}

/**
 * Toggle-button row for choosing a space icon. Each option renders its real
 * glyph beside its visible name (the label is the accessible name; the svg is
 * decorative) and exposes selection as `aria-pressed`. Clicking the selected
 * option clears the choice.
 *
 * Same accessibility recipe as LoginVariantPicker: the container is a named
 * group, options carry the interactive border (WCAG 1.4.11 — never the quiet
 * `border-border` hairline on an operable surface), an explicit
 * focus-visible outline, and the app's 32px control height.
 */
export function SpaceIconPicker({ value, onChange }: SpaceIconPickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Space icon">
      {SPACE_ICONS.map(({ value: iconValue, label, Icon }) => {
        const selected = value === iconValue;
        return (
          <button
            key={iconValue}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? undefined : iconValue)}
            className={`flex min-h-8 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
              selected
                ? 'border-action bg-action/10 text-action font-medium'
                : 'border-border-interactive text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
