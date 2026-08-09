import { Sun, Moon, Monitor } from 'lucide-react';
import { useThemeStore, type ThemePreference } from '../../../stores/theme-store';

/**
 * Header control cycling System → Light → Dark.
 *
 * It cycles a three-way *preference* rather than toggling two palettes,
 * because `system` is the default: a two-state toggle would give a user no way
 * back to "follow my OS" once they had touched it, quietly turning the default
 * into a one-way door on first click.
 *
 * The icon reports the preference, not the painted palette — under `system`
 * that is the monitor glyph, so the control never claims the user chose dark
 * when the OS did.
 */
/* An explicit successor map rather than an array plus modulo: it is total over
   ThemePreference, so adding a fourth preference is a type error here instead
   of a silently skipped rung. */
const NEXT: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const LABEL: Record<ThemePreference, string> = {
  system: 'match system',
  light: 'light',
  dark: 'dark',
};

export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

  const next = NEXT[preference];

  return (
    <button
      onClick={() => setPreference(next)}
      className="nm-icon-button"
      aria-label={`Theme: ${LABEL[preference]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[preference]} — click for ${LABEL[next]}`}
    >
      {preference === 'system' ? (
        <Monitor size={16} />
      ) : preference === 'light' ? (
        <Sun size={16} />
      ) : (
        <Moon size={16} />
      )}
    </button>
  );
}
