import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Sun, Moon, Monitor } from 'lucide-react';
import { useThemeStore, type ThemePreference } from '../../../stores/theme-store';

/**
 * Header control for the three-way *preference* (System / Light / Dark).
 *
 * A named menu, not a cycle: `system` is the default, and a two-state toggle
 * would give a user no way back to "follow my OS". The trigger icon reports
 * the preference, not the painted palette — under `system` that is the
 * monitor glyph, so the control never claims the user chose dark when the
 * OS did.
 */
const OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  Icon: typeof Monitor;
}[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const current = OPTIONS.find((o) => o.value === preference) ?? OPTIONS[0]!;
  const TriggerIcon = current.Icon;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="nm-icon-button"
          aria-label={`Theme: ${current.label}`}
          data-testid="theme-toggle"
        >
          <TriggerIcon size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 min-w-[160px] nm-card-elevated p-1.5"
        >
          {OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenu.Item
              key={value}
              onSelect={() => setPreference(value)}
              data-testid={`theme-option-${value}`}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground"
            >
              <Icon size={14} aria-hidden="true" />
              <span className="flex-1">{label}</span>
              {preference === value && (
                <Check size={14} aria-hidden="true" className="text-foreground" />
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
