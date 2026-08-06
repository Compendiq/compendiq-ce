import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractBlock } from './test-utils';
import {
  THEMES,
  THEME_IDS,
  LIGHT_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCES,
  resolvePreference,
  validateThemeId,
  validateThemePreference,
} from './stores/theme-store';

/**
 * Regression tests for the Graphite + Paper workspace palette — the flat
 * neutral-plus-one-accent system that replaced Slate Steel / Frost Steel and
 * its neumorphic depth model.
 *
 * Two halves, both load-bearing:
 *
 * 1. `Measured contrast` parses the real token values out of index.css and
 *    COMPUTES WCAG ratios rather than asserting hex strings. Retuning a
 *    surface fails loudly with the measured ratio. Carried over intact from
 *    the retired suite — this machinery was the good part and none of it
 *    depended on the palette it was measuring.
 *
 * 2. `Flat depth model` guards the thing that is easy to undo by accident: a
 *    single `box-shadow` added to an in-flow surface, or a `transform` on a
 *    hover state, quietly reintroduces the extrusion this system exists to
 *    remove. That drift is invisible in review — it looks like polish — so it
 *    is asserted mechanically instead.
 */

const cssPath = resolve(__dirname, 'index.css');
const css = readFileSync(cssPath, 'utf-8');

const darkBlock = extractBlock(css, '@theme {');
const lightBlock = extractBlock(css, '[data-theme="paper"] {');
const lightSharedBlock = extractBlock(css, '[data-theme-type="light"] {');

/** Read a `--token: #rrggbb;` declaration out of a CSS block. */
function token(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block);
  if (!m) throw new Error(`token not found (or not a 6-digit hex): ${name}`);
  return m[1].toLowerCase();
}

// --- WCAG 2.1 relative luminance / contrast (SC 1.4.3, 1.4.11) ---
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Assert `fg` on `bg` clears `floor`, reporting the measured ratio on failure. */
function expectContrast(label: string, fg: string, bg: string, floor: number) {
  const ratio = contrast(fg, bg);
  expect(
    ratio,
    `${label}: ${fg} on ${bg} measured ${ratio.toFixed(2)}:1, need ≥${floor}:1`,
  ).toBeGreaterThanOrEqual(floor);
}

describe('Theme store ships exactly Graphite + Paper', () => {
  it('THEMES has two entries', () => {
    expect(THEMES).toHaveLength(2);
    expect(THEME_IDS).toHaveLength(2);
  });

  it('exposes graphite as the dark theme and paper as the light one', () => {
    expect(DEFAULT_DARK_THEME).toBe('graphite');
    expect(DEFAULT_LIGHT_THEME).toBe('paper');
    expect(THEMES.find((t) => t.id === 'graphite')!.category).toBe('dark');
    expect(THEMES.find((t) => t.id === 'paper')!.category).toBe('light');
    expect(LIGHT_THEMES.size).toBe(1);
    expect(LIGHT_THEMES.has('paper')).toBe(true);
  });

  it('retired theme IDs are gone from the shipped set', () => {
    const ids = [...THEME_IDS] as string[];
    for (const id of [
      'void-indigo',
      'obsidian-violet',
      'polar-slate',
      'parchment-glow',
      'ember-dusk',
      'sunrise-cream',
      'graphite-honey',
      'honey-linen',
      'slate-steel',
      'frost-steel',
    ]) {
      expect(ids).not.toContain(id);
    }
  });

  // A user upgrading from Frost Steel must land on the LIGHT theme. Falling
  // through to the dark default would flip a light-mode user to dark on
  // upgrade, which is the single most jarring thing a theme migration can do.
  it('remaps retired light palettes onto the light default, not the dark one', () => {
    for (const id of ['frost-steel', 'honey-linen', 'polar-slate', 'cloud-white']) {
      expect(validateThemeId(id), `${id} should map to the light default`).toBe(
        DEFAULT_LIGHT_THEME,
      );
    }
    expect(validateThemeId('slate-steel')).toBe(DEFAULT_DARK_THEME);
    expect(validateThemeId('nonsense')).toBe(DEFAULT_DARK_THEME);
  });

  it('the picker chips match the rendered surfaces for BOTH themes', () => {
    const cases = [
      { id: 'graphite', block: darkBlock },
      { id: 'paper', block: lightBlock },
    ] as const;

    for (const { id, block } of cases) {
      const meta = THEMES.find((t) => t.id === id)!;
      expect(meta.preview.bg.toLowerCase()).toBe(token(block, '--color-background'));
      expect(meta.preview.card.toLowerCase()).toBe(token(block, '--color-card'));
      expect(meta.preview.primary.toLowerCase()).toBe(token(block, '--color-primary'));
    }
  });
});

describe('Theme preference follows the OS by default', () => {
  it('ships system / dark / light and defaults to system', () => {
    expect([...THEME_PREFERENCES]).toEqual(['system', 'dark', 'light']);
    expect(DEFAULT_THEME_PREFERENCE).toBe('system');
  });

  it('explicit preferences resolve to their palette regardless of the OS', () => {
    expect(resolvePreference('dark')).toBe(DEFAULT_DARK_THEME);
    expect(resolvePreference('light')).toBe(DEFAULT_LIGHT_THEME);
  });

  it('falls back to a valid preference rather than throwing on junk', () => {
    expect(validateThemePreference(undefined)).toBe('system');
    expect(validateThemePreference('sepia')).toBe('system');
    expect(validateThemePreference('light')).toBe('light');
  });

  // `theme` is derived from `preference` + the live OS reading. Persisting it
  // would let a stale resolved value win on the next boot, which is exactly
  // how "follow the OS" silently stops following.
  it('persists the preference only, never the resolved palette', () => {
    const storePath = resolve(__dirname, 'stores/theme-store.ts');
    const source = readFileSync(storePath, 'utf-8');
    const partialize = /partialize:\s*\(state\)\s*=>\s*\(\{([^}]*)\}\)/.exec(source);
    expect(partialize, 'theme-store must declare a partialize').not.toBeNull();
    expect(partialize![1]).toMatch(/preference/);
    expect(partialize![1]).not.toMatch(/\btheme\b/);
  });
});

describe('Measured contrast — Graphite (dark)', () => {
  const bg = token(darkBlock, '--color-background');
  const card = token(darkBlock, '--color-card');
  const elevated = token(darkBlock, '--color-card-elevated');
  const codeBg = token(darkBlock, '--color-code-bg');

  // Flat surfaces mean each pane is ONE value, so there is no lightest-stop
  // worst case to chase — the three surfaces below are the complete set of
  // grounds any text lands on.
  const surfaces = { bg, card, elevated };

  it('body text clears AA on every surface it lands on', () => {
    const fg = token(darkBlock, '--color-foreground');
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`foreground on ${name}`, fg, surface, 4.5);
    }
  });

  it('muted text clears AA on every surface it lands on', () => {
    const muted = token(darkBlock, '--color-muted-foreground');
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`muted-foreground on ${name}`, muted, surface, 4.5);
    }
  });

  it('the accent reads as text on every surface (fill and ink are one value here)', () => {
    const ink = token(darkBlock, '--color-primary-ink');
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`primary-ink on ${name}`, ink, surface, 4.5);
    }
  });

  it('ink on the primary and destructive fills clears AA', () => {
    expectContrast(
      'primary-foreground on primary',
      token(darkBlock, '--color-primary-foreground'),
      token(darkBlock, '--color-primary'),
      4.5,
    );
    expectContrast(
      'destructive-foreground on destructive',
      token(darkBlock, '--color-destructive-foreground'),
      token(darkBlock, '--color-destructive'),
      4.5,
    );
  });

  it('every status colour clears AA on background, card and the elevated pane', () => {
    for (const role of [
      'connected',
      'syncing',
      'embedding',
      'ai',
      'disconnected',
      'inactive',
    ]) {
      const value = token(darkBlock, `--color-status-${role}`);
      for (const [name, surface] of Object.entries(surfaces)) {
        expectContrast(`status-${role} on ${name}`, value, surface, 4.5);
      }
    }
  });

  it('every syntax colour clears AA on the code surface', () => {
    for (const role of ['keyword', 'string', 'function', 'comment', 'number', 'type', 'meta']) {
      expectContrast(
        `code-${role} on code-bg`,
        token(darkBlock, `--color-code-${role}`),
        codeBg,
        4.5,
      );
    }
  });

  // WCAG 1.4.11: the boundary of an operable control needs 3:1. This system
  // has NO shadow to fall back on and forced-colors mode discards shadow
  // anyway — the border is the only thing that survives, so it must measure up
  // on every ground a control can sit on.
  it('the interactive border clears the 3:1 non-text floor on every surface', () => {
    const border = token(darkBlock, '--color-border-interactive');
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`border-interactive on ${name}`, border, surface, 3);
    }
  });
});

describe('Measured contrast — Paper (light)', () => {
  const bg = token(lightBlock, '--color-background');
  const card = token(lightBlock, '--color-card');
  const codeBg = token(lightBlock, '--color-code-bg');
  const surfaces = { bg, card };

  it('body and muted text clear AA on background and card', () => {
    for (const role of ['--color-foreground', '--color-muted-foreground']) {
      const value = token(lightBlock, role);
      for (const [name, surface] of Object.entries(surfaces)) {
        expectContrast(`${role} on ${name}`, value, surface, 4.5);
      }
    }
  });

  // Unlike dark, the light theme keeps a DARKENED accent for text: the fill
  // itself sits too close to the 4.5:1 floor on near-white to be body type.
  it('primary-ink is a distinct, darker value than the primary fill', () => {
    const ink = token(lightBlock, '--color-primary-ink');
    const fill = token(lightBlock, '--color-primary');
    expect(ink).not.toBe(fill);
    expect(luminance(ink)).toBeLessThan(luminance(fill));
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`primary-ink on ${name}`, ink, surface, 4.5);
    }
  });

  it('ink on the primary and destructive fills clears AA', () => {
    expectContrast(
      'primary-foreground on primary',
      token(lightBlock, '--color-primary-foreground'),
      token(lightBlock, '--color-primary'),
      4.5,
    );
    expectContrast(
      'destructive-foreground on destructive',
      token(lightBlock, '--color-destructive-foreground'),
      token(lightBlock, '--color-destructive'),
      4.5,
    );
  });

  it('every status colour clears AA on both background and card', () => {
    for (const role of [
      'connected',
      'syncing',
      'embedding',
      'ai',
      'disconnected',
      'inactive',
    ]) {
      const value = token(lightBlock, `--color-status-${role}`);
      for (const [name, surface] of Object.entries(surfaces)) {
        expectContrast(`status-${role} on ${name}`, value, surface, 4.5);
      }
    }
  });

  it('every syntax colour clears AA on the code surface', () => {
    for (const role of ['keyword', 'string', 'function', 'comment', 'number', 'type', 'meta']) {
      expectContrast(
        `code-${role} on code-bg`,
        token(lightBlock, `--color-code-${role}`),
        codeBg,
        4.5,
      );
    }
  });

  it('the interactive border clears the 3:1 non-text floor', () => {
    const border = token(lightBlock, '--color-border-interactive');
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`border-interactive on ${name}`, border, surface, 3);
    }
  });
});

describe('Both themes declare a complete, symmetric token set', () => {
  // A token present in dark but missing in light silently falls back to the
  // dark value — which is how a light theme ends up with one graphite surface.
  const required = [
    '--color-background',
    '--color-foreground',
    '--color-card',
    '--color-card-elevated',
    '--color-primary',
    '--color-primary-foreground',
    '--color-primary-ink',
    '--color-action',
    '--color-action-foreground',
    '--color-muted-foreground',
    '--color-destructive',
    '--color-destructive-foreground',
    '--color-border',
    '--color-border-interactive',
    '--color-ring',
    '--color-success',
    '--color-warning',
    '--color-info',
    '--color-code-bg',
    '--color-code-keyword',
    '--color-code-string',
    '--color-code-function',
    '--color-code-comment',
    '--color-code-number',
    '--color-code-type',
    '--color-code-meta',
    '--color-status-connected',
    '--color-status-syncing',
    '--color-status-embedding',
    '--color-status-ai',
    '--color-status-disconnected',
    '--color-status-inactive',
  ];

  for (const name of required) {
    it(`declares ${name} in both themes`, () => {
      expect(() => token(darkBlock, name)).not.toThrow();
      expect(() => token(lightBlock, name)).not.toThrow();
    });
  }

  it('both themes declare an overlay shadow', () => {
    for (const block of [darkBlock, lightSharedBlock]) {
      expect(block).toMatch(/--shadow-overlay:/);
      expect(block).toMatch(/--shadow-overlay-sm:/);
    }
  });
});

describe('Flat depth model', () => {
  // Every `--nm-*` extrusion token resolves to `transparent`, so any callsite
  // missed during the conversion — or added later out of habit — renders flat
  // instead of leaving one lonely embossed control behind.
  it('every retired extrusion token is transparent in both themes', () => {
    for (const block of [darkBlock, lightSharedBlock]) {
      for (const name of [
        '--nm-shadow-out',
        '--nm-shadow-out-strong',
        '--nm-shadow-out-hover',
        '--nm-highlight',
        '--nm-highlight-strong',
        '--nm-highlight-hover',
        '--nm-shadow-in',
      ]) {
        const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
        expect(m, `${name} must still be declared`).not.toBeNull();
        expect(m![1].trim(), `${name} must be transparent`).toBe('transparent');
      }
    }
  });

  // Surfaces are flat colours. A gradient on a workspace pane puts a moving
  // value under dense 13px text, so the same row measures differently at the
  // top of a pane than at the bottom.
  it('no surface token is a gradient', () => {
    for (const block of [darkBlock, lightSharedBlock]) {
      for (const name of ['--surface-backdrop', '--surface-card', '--surface-card-elevated']) {
        const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
        expect(m, `${name} must be declared`).not.toBeNull();
        expect(m![1], `${name} must not be a gradient`).not.toMatch(/gradient\(/);
      }
    }
  });

  const inFlow = [
    'nm-card',
    'nm-card-interactive',
    'nm-toolbar',
    'nm-sidebar',
    'nm-header',
    'nm-pill-active',
    'nm-button-primary',
    'nm-button-ghost',
    'nm-button-destructive',
    'nm-icon-button',
    'nm-input',
  ];

  // The one rule that keeps this system flat. An offset/blur shadow on
  // something that never leaves the page is the neumorphic tell; focus rings
  // (`0 0 0 1px`) are not depth and are allowed.
  it('no in-flow surface casts a shadow', () => {
    for (const name of inFlow) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `@utility ${name} must exist`).not.toBe('');
      for (const decl of block.match(/box-shadow:\s*([^;]+);/g) ?? []) {
        expect(
          decl,
          `${name} may only carry a 0-offset focus ring, found: ${decl.trim()}`,
        ).toMatch(/box-shadow:\s*0 0 0 \d+px/);
      }
    }
  });

  // The lift. `translateY(-3px)` on hover and `scale(.97)` on press were the
  // retired system's signature gesture; both are also compositor work on lists
  // running to hundreds of rows.
  it('no interactive utility lifts, scales or rotates', () => {
    for (const name of inFlow) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} must not use transform`).not.toMatch(/transform:/);
    }
  });

  // Exactly one surface may float, and it is the one that genuinely leaves the
  // page: popovers, dropdowns, dialogs, the command palette.
  it('only nm-card-elevated carries the overlay shadow', () => {
    const elevated = extractBlock(css, '@utility nm-card-elevated {');
    expect(elevated).toMatch(/box-shadow:\s*var\(--shadow-overlay\)/);
    for (const name of inFlow) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} must not use the overlay shadow`).not.toMatch(/--shadow-overlay/);
    }
  });

  it('every operable utility keeps a 1px border (WCAG 1.4.11, forced-colors)', () => {
    for (const name of [
      'nm-card-interactive',
      'nm-button-ghost',
      'nm-button-primary',
      'nm-button-destructive',
      'nm-input',
      'nm-composer',
    ]) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} must declare a 1px border`).toMatch(/border:\s*1px\s+solid/);
    }
  });

  // Outlined controls take the MEASURED interactive border, not the quiet
  // hairline used for separators and pane edges.
  it('outlined controls use the interactive border token', () => {
    for (const name of ['nm-button-ghost', 'nm-input', 'nm-composer']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} should use --color-border-interactive`).toMatch(
        /border:\s*1px\s+solid\s+var\(--color-border-interactive\)/,
      );
    }
  });

  // Chrome is the ground, content is the pane — the inversion that makes the
  // document the brightest thing on screen and lets navigation recede.
  it('chrome paints the chassis and content panes paint the card surface', () => {
    for (const name of ['nm-card', 'nm-card-interactive']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} should paint --surface-card`).toMatch(/var\(--surface-card/);
    }
    for (const name of ['nm-sidebar', 'nm-header', 'nm-toolbar']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} is chrome and should paint the chassis`).toMatch(
        /background:\s*var\(--color-background\)/,
      );
    }
  });

  // Both themes are the same ladder expressed in tokens. A light-only shell
  // override is a second place to get the value ladder wrong, and is how the
  // two themes drifted apart under the retired system.
  it('no light-theme override exists for a shell surface', () => {
    for (const name of ['app-header', 'app-sidebar', 'panel-toolbar', 'nav-selection']) {
      const re = new RegExp(`\\[data-theme-type="light"\\]\\s*\\.${name}\\s*\\{`);
      expect(css, `${name} must not have a light-theme override`).not.toMatch(re);
    }
  });
});

describe('Retired palettes leave no residue', () => {
  it('no retired data-theme blocks remain', () => {
    for (const id of [
      'void-indigo',
      'obsidian-violet',
      'polar-slate',
      'parchment-glow',
      'ember-dusk',
      'sunrise-cream',
      'graphite-honey',
      'honey-linen',
      'slate-steel',
      'frost-steel',
    ]) {
      expect(css).not.toMatch(new RegExp(`\\[data-theme="${id}"\\]\\s*\\{`));
    }
  });

  // Both retired brands survived in the CSS as literals rather than as named
  // themes, so a block-name check alone would miss a stray value left behind.
  it('no retired brand hexes survive in the theme blocks', () => {
    const retired = [
      '#f9c74f', '#fdd56d', '#f2b72e', '#8a6016', '#ece9e2', '#121212', // honey
      '#74aefc', '#2b63b7', '#0b121c', '#111a27', '#f4f5f7', '#e8f1f2', // steel
    ];
    for (const value of retired) {
      expect(darkBlock.toLowerCase(), `${value} is a retired brand value`).not.toContain(value);
      expect(lightBlock.toLowerCase(), `${value} is a retired brand value`).not.toContain(value);
    }
  });

  // The display face went with the palette: this system has no display voice,
  // and a stray Space Grotesk reference would put one back on every heading.
  it('the retired display face is gone', () => {
    expect(css).not.toMatch(/Space Grotesk/);
  });
});
