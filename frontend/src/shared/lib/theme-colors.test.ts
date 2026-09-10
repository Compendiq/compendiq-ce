import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  categoricalRamp,
  createThemeColorReader,
  mixOklab,
  withAlpha,
  FALLBACK_NEUTRAL,
  type ReadThemeColor,
} from './theme-colors';

/**
 * The resolver is the only thing standing between the palette and the two
 * renderers that cannot read it (canvas, and any colour derived in JS). Its
 * three failure modes are all silent, so all three are asserted here: a token
 * that resolves to nothing, a document that does not exist, and a value that
 * stops tracking the theme.
 */

afterEach(() => {
  // The SSR case stubs `document` away; restore it before touching it.
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
});

describe('createThemeColorReader', () => {
  it('returns the computed value of a custom property', () => {
    document.documentElement.style.setProperty('--color-status-connected', '#16794a');

    expect(createThemeColorReader()('--color-status-connected')).toBe('#16794a');
  });

  it('trims whitespace the declaration carries', () => {
    document.documentElement.style.setProperty('--color-primary', '  #3f627c  ');

    expect(createThemeColorReader()('--color-primary')).toBe('#3f627c');
  });

  it('falls back when the property is not declared', () => {
    expect(createThemeColorReader()('--color-nope', '#123456')).toBe('#123456');
  });

  it('falls back to the neutral when no fallback is given', () => {
    expect(createThemeColorReader()('--color-nope')).toBe(FALLBACK_NEUTRAL);
  });

  it('falls back rather than throwing when there is no document (SSR)', () => {
    vi.stubGlobal('document', undefined);

    expect(createThemeColorReader()('--color-primary', '#3f627c')).toBe('#3f627c');
  });

  it('serves every property from one snapshot', () => {
    document.documentElement.style.setProperty('--color-a', '#111111');
    document.documentElement.style.setProperty('--color-b', '#222222');
    const read = createThemeColorReader();

    expect([read('--color-a'), read('--color-b')]).toEqual(['#111111', '#222222']);
  });
});

describe('withAlpha', () => {
  it('turns a hex into rgba', () => {
    expect(withAlpha('#3f627c', 0.4)).toBe('rgba(63, 98, 124, 0.4)');
  });

  it('expands the short hex form', () => {
    expect(withAlpha('#abc', 1)).toBe('rgba(170, 187, 204, 1)');
  });

  it('replaces the alpha of an rgba input rather than compounding it', () => {
    expect(withAlpha('rgba(23, 24, 26, 0.9)', 0.35)).toBe('rgba(23, 24, 26, 0.35)');
  });

  it('clamps the alpha to the 0..1 range', () => {
    expect(withAlpha('#000000', 4)).toBe('rgba(0, 0, 0, 1)');
    expect(withAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)');
  });

  it('returns an unparseable colour unchanged instead of throwing', () => {
    // A chart line at the wrong opacity beats a blank pane.
    expect(withAlpha('oklch(70% 0.1 200)', 0.5)).toBe('oklch(70% 0.1 200)');
  });
});

describe('mixOklab', () => {
  it('returns each end of the mix at weight 1 and 0', () => {
    expect(mixOklab('#ff0000', '#0000ff', 1)).toBe('#ff0000');
    expect(mixOklab('#ff0000', '#0000ff', 0)).toBe('#0000ff');
  });

  it('mixes perceptually rather than in sRGB', () => {
    const midpoint = mixOklab('#000000', '#ffffff');
    const channel = parseInt(midpoint.slice(1, 3), 16);

    // A naive sRGB average would be 128. oklab's L is a cube-root lightness,
    // so its midpoint is the grey at half the perceived lightness — luminance
    // 0.125, i.e. sRGB ~99. Guarding the band rather than the exact byte
    // keeps this about the colour space instead of the rounding.
    expect(channel).toBeGreaterThan(90);
    expect(channel).toBeLessThan(110);
  });

  it('lands between its inputs on each channel', () => {
    const mixed = mixOklab('#16794a', '#8a5a00');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(mixed.slice(i, i + 2), 16));

    expect(r).toBeGreaterThan(0x16);
    expect(r).toBeLessThan(0x8a);
    expect(g).toBeGreaterThan(0x5a);
    expect(g).toBeLessThan(0x79);
    expect(b).toBeLessThan(0x4a);
  });

  it('is deterministic', () => {
    expect(mixOklab('#16794a', '#8a5a00')).toBe(mixOklab('#16794a', '#8a5a00'));
  });

  it('degrades to its first input when either side is unparseable', () => {
    expect(mixOklab('#16794a', 'var(--color-primary)')).toBe('#16794a');
  });
});

describe('categoricalRamp', () => {
  // Paper's values, so the ramp is exercised against a real theme rather than
  // against the fallback.
  const tokens: Record<string, string> = {
    '--color-info': '#3f49b8',
    '--color-status-connected': '#16794a',
    '--color-status-syncing': '#8a5a00',
    '--color-status-disconnected': '#c03434',
    '--color-status-ai': '#7041a8',
    '--color-primary': '#3f627c',
    '--color-status-inactive': '#6a6a68',
  };
  const read: ReadThemeColor = (property, fallback = FALLBACK_NEUTRAL) =>
    tokens[property] ?? fallback;

  it('returns exactly the requested number of entries', () => {
    expect(categoricalRamp(read, 12)).toHaveLength(12);
    expect(categoricalRamp(read, 3)).toHaveLength(3);
  });

  it('serves the palette tokens themselves before deriving anything', () => {
    expect(categoricalRamp(read, 7)).toEqual(Object.values(tokens));
  });

  it('keeps every entry of a twelve-colour ramp distinct', () => {
    const ramp = categoricalRamp(read, 12);

    expect(new Set(ramp).size).toBe(12);
  });

  it('derives the extra entries from the tokens, so they are theme-dependent', () => {
    const paper = categoricalRamp(read, 12);
    const graphite = categoricalRamp((property, fallback) => {
      const swapped: Record<string, string> = {
        ...tokens,
        '--color-info': '#8b93f8',
        '--color-status-connected': '#4ade80',
      };
      return swapped[property] ?? fallback ?? FALLBACK_NEUTRAL;
    }, 12);

    // Entry 7 is the oklab midpoint of info × connected; both moved, so it must.
    expect(graphite[7]).not.toBe(paper[7]);
  });

  it('is deterministic per theme', () => {
    expect(categoricalRamp(read, 12)).toEqual(categoricalRamp(read, 12));
  });
});
