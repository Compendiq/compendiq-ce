import { useThemeStore, isLightTheme } from '../../stores/theme-store';

/**
 * Returns true if the current theme is a light theme.
 * Useful for conditionally applying dark-only classes like `prose-invert`.
 */
export function useIsLightTheme(): boolean {
  const theme = useThemeStore((s) => s.theme);
  return isLightTheme(theme);
}
