import { Sun, Moon } from 'lucide-react';
import { useThemeStore, isLightTheme, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME } from '../../../stores/theme-store';

/**
 * Header toggle that switches between dark and light modes.
 * Dark → defaults to void-indigo, Light → defaults to polar-slate.
 */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const light = isLightTheme(theme);

  function toggle() {
    setTheme(light ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME);
  }

  return (
    <button
      onClick={toggle}
      className="glass-button-ghost hover:bg-foreground/10"
      aria-label={light ? 'Switch to dark mode' : 'Switch to light mode'}
      title={light ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      {light ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}
