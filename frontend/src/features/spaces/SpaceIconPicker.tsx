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
 */
export function SpaceIconPicker({ value, onChange }: SpaceIconPickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SPACE_ICONS.map(({ value: iconValue, label, Icon }) => {
        const selected = value === iconValue;
        return (
          <button
            key={iconValue}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? undefined : iconValue)}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
              selected
                ? 'border-action bg-action/10 text-action font-medium'
                : 'border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
            }`}
          >
            <Icon size={12} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
