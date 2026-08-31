/**
 * Chart chrome — grid, axes, tooltip, legend — expressed in palette tokens.
 *
 * Recharts' defaults are baked light-theme greys (`#666` ticks, a white
 * tooltip card), invisible or wrong on Graphite and untouched by a theme
 * switch. Chrome is plain CSS: these land as SVG presentation attributes or
 * inline styles, so `var(--color-…)` is resolved by the browser per theme with
 * no JS involved.
 *
 * Series colours are the opposite case and go through `useThemeColors` — a
 * series colour has to be readable as a value (mixed, alpha-adjusted, painted
 * to canvas), which `var()` cannot do.
 *
 * Kept out of `ChartsBundle` on purpose: that module exists so recharts stays
 * in its own chunk, and every dashboard test replaces it wholesale with
 * render stubs.
 */

/** Grid lines and axis rules: the palette's hairline. */
export const CHART_GRID_STROKE = 'var(--color-border)';

/** Axis tick labels. Spread alongside the per-chart `fontSize`. */
export const CHART_TICK_FILL = 'var(--color-muted-foreground)';

/** Tooltip card — the elevated surface, not Recharts' white box. */
export const CHART_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: 'var(--color-card-elevated)',
  border: '1px solid var(--color-border)',
  borderRadius: '0.5rem',
  color: 'var(--color-foreground)',
  fontSize: 12,
} as const;

/** Tooltip heading (the category/date), one step quieter than its rows. */
export const CHART_TOOLTIP_LABEL_STYLE = {
  color: 'var(--color-muted-foreground)',
} as const;

export const CHART_LEGEND_WRAPPER_STYLE = {
  color: 'var(--color-muted-foreground)',
  fontSize: 12,
} as const;
