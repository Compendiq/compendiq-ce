import { useEffect } from 'react';
import { useThemeStore } from '../../stores/theme-store';

/**
 * Applies the selected theme as a data-theme attribute on <html>.
 * The default theme (midnight-blue) uses no attribute so the base CSS variables apply.
 */
export function useThemeEffect() {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'midnight-blue') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);
}
