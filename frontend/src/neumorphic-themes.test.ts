import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  THEMES,
  THEME_IDS,
  LIGHT_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
} from './stores/theme-store';

/**
 * Regression tests for the Honey Linen + Graphite Honey neumorphic theme overhaul (#30).
 * Palette mirrors compendiq-landing/src/styles/tokens.css for cross-surface brand parity.
 *
 * Verifies:
 *  - Theme store ships exactly two themes.
 *  - Retired theme IDs are gone.
 *  - index.css carries the brand anchors (linen / graphite / honey) in both
 *    the default @theme block (Graphite Honey = system default) and the
 *    [data-theme="honey-linen"] block.
 *  - Neumorphic shadow tokens (--nm-*) and status color tokens (--color-status-*)
 *    are defined for both themes; --color-primary-ink token exists for the
 *    WCAG-safe accent-as-text pattern.
 */

const cssPath = resolve(__dirname, 'index.css');
const css = readFileSync(cssPath, 'utf-8');

function extractBlock(source: string, openingLine: string): string {
  const startIndex = source.indexOf(openingLine);
  if (startIndex === -1) return '';
  const braceStart = source.indexOf('{', startIndex);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return '';
}

const themeBlock = extractBlock(css, '@theme {');
const honeyLinenBlock = extractBlock(css, '[data-theme="honey-linen"] {');
const lightSharedBlock = extractBlock(css, '[data-theme-type="light"] {');

describe('Theme store ships exactly Graphite Honey + Honey Linen', () => {
  it('THEMES has two entries', () => {
    expect(THEMES).toHaveLength(2);
    expect(THEME_IDS).toHaveLength(2);
  });

  it('default dark theme is graphite-honey', () => {
    expect(DEFAULT_DARK_THEME).toBe('graphite-honey');
  });

  it('default light theme is honey-linen', () => {
    expect(DEFAULT_LIGHT_THEME).toBe('honey-linen');
  });

  it('exposes graphite-honey as a dark theme', () => {
    const dark = THEMES.find((t) => t.id === 'graphite-honey');
    expect(dark).toBeDefined();
    expect(dark!.category).toBe('dark');
  });

  it('exposes honey-linen as a light theme', () => {
    const light = THEMES.find((t) => t.id === 'honey-linen');
    expect(light).toBeDefined();
    expect(light!.category).toBe('light');
  });

  it('LIGHT_THEMES contains only honey-linen', () => {
    expect(LIGHT_THEMES.size).toBe(1);
    expect(LIGHT_THEMES.has('honey-linen')).toBe(true);
  });

  it('retired theme IDs are gone', () => {
    const ids = [...THEME_IDS] as string[];
    const retired = [
      'void-indigo',
      'obsidian-violet',
      'polar-slate',
      'parchment-glow',
      'ember-dusk',
      'sunrise-cream',
    ];
    for (const id of retired) {
      expect(ids).not.toContain(id);
    }
  });

  it('theme labels match the spec', () => {
    expect(THEMES.find((t) => t.id === 'graphite-honey')!.label).toBe('Graphite Honey');
    expect(THEMES.find((t) => t.id === 'honey-linen')!.label).toBe('Honey Linen');
  });

  it('descriptions mention honey / linen / graphite vocabulary', () => {
    const dark = THEMES.find((t) => t.id === 'graphite-honey')!;
    const light = THEMES.find((t) => t.id === 'honey-linen')!;
    expect(dark.description.toLowerCase()).toMatch(/graphite|honey|neumorph/);
    expect(light.description.toLowerCase()).toMatch(/linen|honey|cream|neumorph/);
  });

  it('preview hex colors carry the brand anchors', () => {
    const dark = THEMES.find((t) => t.id === 'graphite-honey')!;
    const light = THEMES.find((t) => t.id === 'honey-linen')!;
    expect(dark.preview.bg.toLowerCase()).toBe('#121211');
    expect(dark.preview.primary.toLowerCase()).toBe('#f9c74f');
    // Honey Linen background must match the actual rendered surface
    // (`--color-background` in [data-theme="honey-linen"]), not a brand-y
    // approximation — the picker chip is the only preview users see.
    expect(light.preview.bg.toLowerCase()).toBe('#f7f7f4');
    expect(light.preview.primary.toLowerCase()).toBe('#f9c74f');
  });

  it('honey-linen preview chips match the rendered [data-theme="honey-linen"] surfaces', () => {
    // The picker chip is the only way users preview a theme before applying
    // it — chip ↔ surface drift is a UX bug. Pull the canonical values out
    // of index.css and assert the THEMES metadata matches exactly.
    const linenBlock = extractBlock(css, '[data-theme="honey-linen"] {');
    const bgMatch = /--color-background:\s*(#[0-9a-fA-F]{3,8})/.exec(linenBlock);
    const cardMatch = /--color-card:\s*(#[0-9a-fA-F]{3,8})/.exec(linenBlock);
    expect(bgMatch).not.toBeNull();
    expect(cardMatch).not.toBeNull();

    const light = THEMES.find((t) => t.id === 'honey-linen')!;
    expect(light.preview.bg.toLowerCase()).toBe(bgMatch![1].toLowerCase());
    expect(light.preview.card.toLowerCase()).toBe(cardMatch![1].toLowerCase());
  });
});

describe('Default @theme block carries Graphite Honey anchors', () => {
  it('has the @theme block', () => {
    expect(themeBlock).not.toBe('');
  });

  it('background is graphite #121211', () => {
    expect(themeBlock).toMatch(/--color-background:\s*#121211/i);
  });

  it('foreground is warm cream #f5efe0', () => {
    expect(themeBlock).toMatch(/--color-foreground:\s*#f5efe0/i);
  });

  it('primary is brand honey #f9c74f', () => {
    expect(themeBlock).toMatch(/--color-primary:\s*#f9c74f/i);
  });

  it('primary-foreground is brand black #0a0a0a', () => {
    expect(themeBlock).toMatch(/--color-primary-foreground:\s*#0a0a0a/i);
  });

  it('muted-foreground is the #346-lifted #a39e8c (≥ AA on bg-background)', () => {
    // Pinned by #346: #a39e8c lands at 6.99:1 against --color-background
    // (#121211). Drift here re-introduces the "too dim" sidebar text bug.
    expect(themeBlock).toMatch(/--color-muted-foreground:\s*#a39e8c/i);
  });

  it('defines --color-primary-ink for accent-as-text', () => {
    expect(themeBlock).toMatch(/--color-primary-ink/);
  });

  it('defines neumorphic shadow tokens', () => {
    expect(themeBlock).toMatch(/--nm-shadow-out/);
    expect(themeBlock).toMatch(/--nm-shadow-in/);
    expect(themeBlock).toMatch(/--nm-highlight/);
  });

  it('defines status color tokens', () => {
    expect(themeBlock).toMatch(/--color-status-connected/);
    expect(themeBlock).toMatch(/--color-status-syncing/);
    expect(themeBlock).toMatch(/--color-status-embedding/);
    expect(themeBlock).toMatch(/--color-status-ai/);
    expect(themeBlock).toMatch(/--color-status-disconnected/);
    expect(themeBlock).toMatch(/--color-status-inactive/);
  });

  it('defines per-language code color tokens', () => {
    expect(themeBlock).toMatch(/--color-code-bg/);
    expect(themeBlock).toMatch(/--color-code-keyword/);
    expect(themeBlock).toMatch(/--color-code-string/);
    expect(themeBlock).toMatch(/--color-code-function/);
    expect(themeBlock).toMatch(/--color-code-comment/);
    expect(themeBlock).toMatch(/--color-code-number/);
  });
});

describe('[data-theme="honey-linen"] block', () => {
  it('exists', () => {
    expect(honeyLinenBlock).not.toBe('');
  });

  it('background is near-white with a hint of warmth', () => {
    // Was #fbf7ef (warmer linen); shifted to #f7f7f4 — near-neutral white
    // per the v0.4 refinement to reduce yellow cast in the light theme.
    expect(honeyLinenBlock).toMatch(/--color-background:\s*#f7f7f4/i);
  });

  it('foreground is brand near-black #0a0a0a', () => {
    expect(honeyLinenBlock).toMatch(/--color-foreground:\s*#0a0a0a/i);
  });

  it('primary is brand honey #f9c74f (same as dark)', () => {
    expect(honeyLinenBlock).toMatch(/--color-primary:\s*#f9c74f/i);
  });

  it('primary-foreground is brand black #0a0a0a', () => {
    expect(honeyLinenBlock).toMatch(/--color-primary-foreground:\s*#0a0a0a/i);
  });

  it('defines darkened --color-primary-ink #8a6016 for AA-safe text use', () => {
    expect(honeyLinenBlock).toMatch(/--color-primary-ink:\s*#8a6016/i);
  });

  it('muted-foreground is the #346-darkened #5f5c54 (≥ AA on bg-background)', () => {
    // Pinned by #346: #5f5c54 lands at 6.22:1 against --color-background
    // (#f7f7f4). Drift here re-introduces the washed-out sidebar text bug.
    expect(honeyLinenBlock).toMatch(/--color-muted-foreground:\s*#5f5c54/i);
  });

  it('overrides status color tokens', () => {
    expect(honeyLinenBlock).toMatch(/--color-status-connected/);
    expect(honeyLinenBlock).toMatch(/--color-status-syncing/);
    expect(honeyLinenBlock).toMatch(/--color-status-embedding/);
    expect(honeyLinenBlock).toMatch(/--color-status-ai/);
    expect(honeyLinenBlock).toMatch(/--color-status-disconnected/);
    expect(honeyLinenBlock).toMatch(/--color-status-inactive/);
  });

  it('overrides per-language code tokens', () => {
    expect(honeyLinenBlock).toMatch(/--color-code-keyword/);
    expect(honeyLinenBlock).toMatch(/--color-code-string/);
    expect(honeyLinenBlock).toMatch(/--color-code-function/);
  });
});

describe('Retired themes are gone from index.css', () => {
  it('no retired data-theme blocks remain', () => {
    const retired = [
      'void-indigo',
      'obsidian-violet',
      'polar-slate',
      'parchment-glow',
      'ember-dusk',
      'sunrise-cream',
    ];
    for (const id of retired) {
      const re = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{`);
      expect(css).not.toMatch(re);
    }
  });
});

describe('Light-shared block carries linen-tuned neumorphic adjustments', () => {
  it('exists', () => {
    expect(lightSharedBlock).not.toBe('');
  });

  it('redefines --nm-shadow-out for light surfaces', () => {
    expect(lightSharedBlock).toMatch(/--nm-shadow-out/);
  });

  it('redefines --nm-highlight for light surfaces', () => {
    expect(lightSharedBlock).toMatch(/--nm-highlight/);
  });

  it('uses warm-brown shadow tint matching the linen palette', () => {
    expect(lightSharedBlock).toMatch(/rgba\(\s*50,\s*42,\s*20/);
  });
});

describe('Neumorphic @utility set', () => {
  const expectedUtilities = [
    'nm-card',
    'nm-card-elevated',
    'nm-card-interactive',
    'nm-toolbar',
    'nm-sidebar',
    'nm-header',
    'nm-pill-active',
    'nm-button-primary',
    'nm-button-ghost',
    'nm-icon-button',
    'nm-input',
  ] as const;

  for (const name of expectedUtilities) {
    it(`defines @utility ${name}`, () => {
      const re = new RegExp(`@utility\\s+${name}\\s*\\{`);
      expect(css).toMatch(re);
    });
  }

  it('every interactive utility carries a 1px hybrid border (WCAG 1.4.11)', () => {
    const interactive = [
      'nm-card-interactive',
      'nm-button-primary',
      'nm-button-ghost',
      'nm-icon-button',
      'nm-input',
    ];
    for (const name of interactive) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block).not.toBe('');
      expect(block).toMatch(/border:\s*1(?:\.\d+)?(?:px|\.5px)?\s+solid|border:\s*1\.5px\s+solid/);
    }
  });

  it('every interactive utility has a :focus-visible rule', () => {
    const interactive = [
      'nm-card-interactive',
      'nm-button-primary',
      'nm-button-ghost',
      'nm-icon-button',
      'nm-input',
    ];
    for (const name of interactive) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block).toMatch(/&:focus(?:-visible)?/);
    }
  });

  it('declares forced-colors fallback restoring system borders', () => {
    expect(css).toMatch(/@media\s*\(\s*forced-colors:\s*active\s*\)/);
    const fc = css.match(/@media\s*\(\s*forced-colors:\s*active\s*\)\s*\{([\s\S]*?)\n\}/);
    expect(fc).not.toBeNull();
    expect(fc![1]).toMatch(/\.nm-card/);
    expect(fc![1]).toMatch(/border:\s*\d+px\s+solid\s+ButtonText/);
  });

  it('declares prefers-reduced-motion override stripping transform', () => {
    const matches = [...css.matchAll(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const nmReducedMotion = css.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^}]*\.nm-/,
    );
    expect(nmReducedMotion).not.toBeNull();
  });
});
