/**
 * Resolving palette tokens to concrete colour values.
 *
 * Everything CSS paints should reference `--color-*` directly — through a
 * Tailwind utility or `var(--color-…)`. Two consumers in this app cannot:
 *
 *   - `<canvas>`: `ctx.fillStyle = 'var(--color-foreground)'` is silently
 *     ignored, so react-force-graph-2d needs the computed value.
 *   - any colour that has to be *derived* (an alpha variant, an oklab mix)
 *     before it reaches a renderer.
 *
 * Both were served by hand-copied hexes, which is exactly what goes stale:
 * the graph canvas still carried `#17181a` after Paper's `--color-foreground`
 * moved to `#191918`, and the analytics dashboards carried Tailwind v3
 * defaults that fail contrast on the light pane (`#10b981` measures 2.54:1 on
 * white where `--color-status-connected` measures 5.43:1). Reading the value
 * back off `<html>` keeps `index.css` the single source of truth.
 *
 * Pair this with `useThemeColors` (../hooks/use-theme-colors) in components:
 * the hook re-runs the resolution when the active theme changes.
 */

/**
 * Last-resort values for environments where no stylesheet is loaded — SSR and
 * jsdom, where a custom property resolves to the empty string. Deliberately
 * NOT copies of any token: a copied token is the failure mode this module
 * exists to remove, whereas plain black / white / mid-grey cannot drift.
 */
export const FALLBACK_INK = '#000000';
export const FALLBACK_PAPER = '#ffffff';
export const FALLBACK_NEUTRAL = '#808080';

/** Reads one `--color-*` property off the document, or `fallback`. */
export type ReadThemeColor = (property: string, fallback?: string) => string;

/**
 * Bind a reader to the document's current computed style.
 *
 * One `getComputedStyle` call serves every property a caller asks for, which
 * matters because building a categorical ramp reads a dozen of them. The
 * snapshot is taken when the reader is created, so create a new one after the
 * theme changes rather than holding one forever — `useThemeColors` does that.
 */
export function createThemeColorReader(): ReadThemeColor {
  const style =
    typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  return (property, fallback = FALLBACK_NEUTRAL) => {
    const value = style?.getPropertyValue(property).trim();
    return value ? value : fallback;
  };
}

// ── Colour maths ───────────────────────────────────────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse the colour forms a resolved token can take. Custom properties come
 * back as the declared token stream, and every `--color-*` in `index.css` is
 * a hex or an `rgba()`; the space-separated `rgb()` form is accepted because
 * a browser may hand one back through a non-custom property. Anything else
 * (`color-mix()`, `oklch()`, a keyword) returns null and the caller degrades
 * rather than throwing inside a chart render.
 */
function parseColor(value: string): Rgb | null {
  const text = value.trim();

  const digits = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (digits) {
    // 3- and 4-digit forms carry one digit per channel, doubled: #abc → #aabbcc.
    const width = digits.length <= 4 ? 1 : 2;
    const channel = (index: number) => {
      const pair = digits.slice(index * width, index * width + width);
      return parseInt(width === 1 ? pair + pair : pair, 16);
    };
    return { r: channel(0), g: channel(1), b: channel(2) };
  }

  const args = /^rgba?\(([^)]+)\)$/i.exec(text)?.[1];
  if (args) {
    const [r, g, b] = args.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (r === undefined || g === undefined || b === undefined) return null;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return { r, g, b };
  }

  return null;
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * `color` at `alpha`, as an `rgba()` string. Used where a renderer needs one
 * opaque string rather than a colour plus an opacity channel — canvas
 * `fillStyle`/`strokeStyle` take no separate alpha. Unparseable input is
 * returned unchanged: a chart line in the wrong opacity beats a blank pane.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${clamp255(rgb.r)}, ${clamp255(rgb.g)}, ${clamp255(rgb.b)}, ${a})`;
}

// sRGB ⇄ OKLab, per Björn Ottosson's reference conversion. Mixing in a
// perceptual space is what makes a midpoint between two palette hues read as
// a *third* hue rather than as mud, which is the whole point of deriving
// categorical entries instead of inventing them.

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(n: number): number {
  const c = n <= 0.0031308 ? n * 12.92 : 1.055 * n ** (1 / 2.4) - 0.055;
  return c * 255;
}

function rgbToOklab({ r, g, b }: Rgb): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, A, B]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/**
 * The programmatic equivalent of `color-mix(in oklab, a <weight>%, b)`, as a
 * 6-digit hex. CSS `color-mix()` would be the natural spelling, but a mixed
 * value has to reach `ctx.fillStyle`, which resolves no CSS functions.
 *
 * `weight` is the share of `a`; 0.5 is the midpoint.
 */
export function mixOklab(a: string, b: string, weight = 0.5): string {
  const rgbA = parseColor(a);
  const rgbB = parseColor(b);
  if (!rgbA || !rgbB) return a;

  const w = Math.max(0, Math.min(1, weight));
  const [lA, aA, bA] = rgbToOklab(rgbA);
  const [lB, aB, bB] = rgbToOklab(rgbB);
  const mixed = oklabToRgb([
    lA * w + lB * (1 - w),
    aA * w + aB * (1 - w),
    bA * w + bB * (1 - w),
  ]);

  return `#${[mixed.r, mixed.g, mixed.b]
    .map((c) => clamp255(c).toString(16).padStart(2, '0'))
    .join('')}`;
}

// ── Categorical ramp ──────────────────────────────────────────────────────────

/**
 * The palette's distinct hues, ordered so that the first entries of a ramp are
 * the furthest apart.
 *
 * `--color-status-embedding` is omitted, and the reason was re-derived when
 * that token stopped being a hue. It used to be excluded as a DUPLICATE: it
 * was declared byte-identical to `--color-primary` in both themes. It now
 * resolves to `--color-foreground`, so it stays out for three stronger
 * reasons, any one of which is sufficient:
 *
 *  1. Still a duplicate — of `--color-foreground`, which `--color-action`
 *     already tracks.
 *  2. It carries no hue at all. `categoricalRamp` below fills entries past
 *     the base list with oklab midpoints of ADJACENT pairs, so one neutral
 *     member would desaturate two derived colours as well as its own slot.
 *  3. These colours are identity FILLS with labels drawn on them. A tile the
 *     colour of body ink measures 1:1 against the ink on top of it.
 */
const CATEGORICAL_TOKENS = [
  '--color-info',
  '--color-status-connected',
  '--color-status-syncing',
  '--color-status-disconnected',
  '--color-status-ai',
  '--color-primary',
  '--color-status-inactive',
] as const;

/**
 * `count` visually distinct colours for a scale that keys on *identity*
 * rather than status — graph spaces, treemap tiles. Such a scale has no
 * semantics to map onto the status tokens: a space is not "healthy", it just
 * has to differ from the space next to it. That is the only reason a
 * categorical ramp exists here at all; anything with a meaning uses its own
 * token directly.
 *
 * The palette owns seven distinct hues. Entries beyond those are oklab
 * midpoints of adjacent pairs, so every colour is derived from the active
 * theme — retuning a token retunes the ramp, and no hue is invented outside
 * the palette. Deterministic: index N is always the same colour for a theme.
 * Past `2 × 7` entries the midpoints repeat; no caller needs that many.
 */
export function categoricalRamp(read: ReadThemeColor, count: number): string[] {
  const base = CATEGORICAL_TOKENS.map((token) => read(token));
  const at = (index: number) => base[index % base.length] ?? FALLBACK_NEUTRAL;

  const ramp: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i < base.length) {
      ramp.push(at(i));
      continue;
    }
    const pair = i - base.length;
    ramp.push(mixOklab(at(pair), at(pair + 1)));
  }
  return ramp;
}
