import { useThemeStore, isLightTheme } from '../../stores/theme-store';

/**
 * Returns true if the current theme is a light theme.
 *
 * For styling, prefer the CSS cascade (`[data-theme-type="light"]`) — this
 * hook is for the places that cannot: canvas/SVG renderers such as the graph
 * canvas and Mermaid, which need the brightness as a JS value to pick their
 * own palette and to re-render when the theme flips.
 */
export function useIsLightTheme(): boolean {
  const theme = useThemeStore((s) => s.theme);
  return isLightTheme(theme);
}
