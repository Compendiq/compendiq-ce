import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { extractBlock, composite } from './test-utils';
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

/**
 * Read a token, following `var(--…)` aliases declared in the same block.
 * The semantic trio (success / warning / destructive) is declared as
 * references onto the status tokens, so measuring it means resolving the
 * reference first.
 */
function resolveToken(block: string, name: string, depth = 0): string {
  if (depth > 4) throw new Error(`alias chain too deep resolving ${name}`);
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`token not declared: ${name}`);
  const value = m[1].trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolveToken(block, ref[1], depth + 1);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`token is neither a 6-digit hex nor a var() reference: ${name}: ${value}`);
  }
  return value.toLowerCase();
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

// The alpha-composite helper is shared from test-utils.ts (imported above):
// setup-status-tokens.test.ts measures tints with the same math, and two local
// copies with reversed signatures once invited surface-over-ink mistakes.

/** Strip block and line comments so source scans don't trip on prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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

describe('Surface hierarchy — reading comfort in dark, warm paper in light', () => {
  it('lifts the Graphite pane clearly above its near-black workspace', () => {
    const workspace = token(darkBlock, '--color-background');
    const pane = token(darkBlock, '--color-card');
    const raised = token(darkBlock, '--color-card-elevated');

    expect(luminance(pane)).toBeGreaterThan(luminance(workspace));
    expect(contrast(pane, workspace)).toBeGreaterThanOrEqual(1.05);
    expect(luminance(raised)).toBeGreaterThan(luminance(pane));
  });

  // Paper's Pane is pure white by product decision (2026-08-30): the document,
  // the left navigation pane and the context rail are #ffffff, and the warm
  // ramp lives in the frame around them. So the claim here is no longer "the
  // pane stays off white" — it is that the pane is white, that Workspace stays
  // BELOW it so the seam survives on value and not only on the hairline, and
  // that Raised does not try to out-lighten white.
  it('paints the Paper pane pure white above a warm workspace ground', () => {
    const workspace = token(lightBlock, '--color-background');
    const pane = token(lightBlock, '--color-card');
    const raised = token(lightBlock, '--color-card-elevated');

    expect(pane).toBe('#ffffff');
    expect(luminance(pane)).toBeGreaterThan(luminance(workspace));
    expect(raised).toBe(pane);
  });

  // Losing the Pane→Raised value step means the overlay shadow is the whole
  // separation, so it must actually be declared with an offset and a blur —
  // a flat halo would leave a white popover invisible on a white page.
  it('carries an offset overlay shadow now that Raised matches Pane in Paper', () => {
    const m = /--shadow-overlay:\s*([^;]+);/.exec(lightSharedBlock);
    expect(m, 'the light theme must declare --shadow-overlay').not.toBeNull();
    expect(m![1]!.trim(), 'the light overlay shadow needs a Y offset and a blur').toMatch(
      /0 [1-9]\d*px \d+px/,
    );
  });

  // Paper is a warm neutral: every surface, fill, border and ink in the block
  // sits on the warm side of the hue circle. A cool grey slipping back in is
  // the regression this guards — it is what the palette was before, and one
  // stray #f7f7f8 reads as a blue patch against the rest.
  it('keeps every Paper neutral on the warm side of the hue circle', () => {
    const neutrals = [
      '--color-background',
      '--color-foreground',
      '--color-secondary',
      '--color-secondary-foreground',
      '--color-muted',
      '--color-muted-foreground',
      '--color-accent',
      '--color-border',
      '--color-border-interactive',
      '--color-action',
      '--color-action-hover',
      '--color-code-bg',
      '--color-status-inactive',
      '--app-chassis',
      '--app-header-bg',
    ];
    for (const name of neutrals) {
      const hex = token(lightBlock, name);
      const [r, , b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
      expect(r, `${name} (${hex}) must be warm: red channel above blue`).toBeGreaterThan(b);
    }
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
      resolveToken(darkBlock, '--color-destructive'),
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

  // Paper's desaturated Steel fill is already dark enough to serve as text;
  // keep measuring the text role independently so a future retune cannot
  // silently drop it under AA.
  it('primary-ink clears AA on every light surface', () => {
    const ink = token(lightBlock, '--color-primary-ink');
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
      resolveToken(lightBlock, '--color-destructive'),
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

  it('the interactive border clears the 3:1 non-text floor on every surface', () => {
    // Not `surfaces` — that is `{ bg, card }`, and measuring an operable edge
    // against only those two is how this test carried the name "every surface"
    // while the ADR's "≥3:1 on every surface" went unchecked. The border was
    // 2.90:1 on the hovered `accent` fill: under the floor exactly when the
    // pointer is on the control, which is when the edge matters most.
    //
    // A control can sit on any of these four in Paper, so all four are the
    // claim. `accent` is the hover/selected fill, `muted` the quiet field fill,
    // `elevated` the popover surface.
    const controlGrounds = {
      bg,
      card,
      elevated: token(lightBlock, '--color-card-elevated'),
      accent: token(lightBlock, '--color-accent'),
      muted: token(lightBlock, '--color-muted'),
    };
    const border = token(lightBlock, '--color-border-interactive');
    for (const [name, surface] of Object.entries(controlGrounds)) {
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
    '--app-chassis',
    '--app-shell-bg',
    '--app-rail-bg',
  ];

  for (const name of required) {
    it(`declares ${name} in both themes`, () => {
      // resolveToken, not token: the semantic aliases are declared as var()
      // references, and this test's claim is "declared in both blocks with a
      // value that resolves" — a missing declaration still throws.
      expect(() => resolveToken(darkBlock, name)).not.toThrow();
      expect(() => resolveToken(lightBlock, name)).not.toThrow();
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

  // The checks above only walk `@utility` blocks, and that blind spot shipped:
  // a live `.drawio-nodeview:hover { box-shadow: 0 0 0 1px … }` survived the
  // whole conversion because it is a plain class rule. This sweeps the entire
  // stylesheet for depth shadows written anywhere.
  it('no plain class rule declares a depth shadow', () => {
    const offenders: string[] = [];
    let examined = 0;
    // Every box-shadow declaration in the file, with the selector above it.
    const re = /([^{}]+)\{([^{}]*box-shadow:[^;}]+;[^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      const selector = m[1]!.trim().split('\n').pop()!.trim();
      for (const decl of m[2]!.match(/box-shadow:\s*([^;]+);/g) ?? []) {
        examined++;
        const value = decl.replace(/box-shadow:\s*/, '').replace(/;\s*$/, '').trim();
        // Allowed: `none`, focus rings (0 0 0 Npx), and the one overlay token.
        if (/^none$/.test(value)) continue;
        if (/^0 0 0 \d+px/.test(value)) continue;
        if (/var\(--shadow-overlay(-sm)?\)/.test(value)) continue;
        // Retired tokens resolve to `transparent`, so they paint nothing.
        if (/var\(--nm-(shadow|highlight)/.test(value)) continue;
        offenders.push(`${selector} → ${value}`);
      }
    }
    // Self-check: a regex that silently stopped matching would report zero
    // offenders and pass forever. The stylesheet genuinely declares box-shadow
    // in several places (focus rings, the overlay token), so a run that
    // examined none means the sweep broke, not that the CSS got cleaner.
    expect(examined, 'the shadow sweep matched nothing — its regex is stale').toBeGreaterThan(5);
    expect(
      offenders,
      `depth shadows outside the overlay contract:\n${offenders.join('\n')}`,
    ).toEqual([]);
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
    for (const name of ['app-header', 'app-sidebar', 'app-chassis', 'app-shell', 'app-context-rail', 'panel-toolbar', 'nav-selection']) {
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

describe('Colour carries meaning, and only its own', () => {
  const badgePath = resolve(__dirname, 'shared/components/badges/QualityScoreBadge.tsx');
  const badgeSource = readFileSync(badgePath, 'utf-8');

  // Quality is a measurement, not a pipeline state. It used to be painted with
  // the status palette — ≥70 in `status-embedding` (Steel) and ≥50 in
  // `status-syncing` (amber) — so on the Pages list a page scoring 65 wore the
  // same amber as a space mid-sync, and one scoring 74 the same Steel as
  // "embedding". Those are the two most tightly reserved hues in the system
  // (amber = warning only, Steel = brand AND interaction), on the densest
  // scanning surface in the app.
  //
  // This guard lives beside the palette rather than only in the component's own
  // test because it is a statement about what the palette MEANS, and the next
  // person to reach for a ready-made status colour will be reading these tokens.
  it('the quality score does not wear the pipeline status palette', () => {
    const scoreBands = /score >= (?:90|70|50)[\s\S]{0,400}?status-(connected|syncing|embedding|disconnected)/;
    expect(
      badgeSource,
      'quality score bands must not resolve status-* colours; the score is neutral and carries its band in the meter',
    ).not.toMatch(scoreBands);
  });

  it('the quality badge carries no hardcoded hex literals', () => {
    // Two literals (#fae2e0/#7a1e1a and #efeeea/#5f5c54) used to live here — a
    // warm beige that existed nowhere else in a palette declared neutral, and
    // which every test in this file was structurally blind to.
    const hexes = badgeSource.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexes, `move these onto tokens so this file can see them: ${hexes.join(', ')}`).toEqual([]);
  });

  // Amber is reserved for warning and attention. Failure is the one quality
  // state that qualifies, so it is the one that may keep it.
  it('amber survives on the failed state only', () => {
    expect(badgeSource).toMatch(/status === 'failed'[\s\S]{0,300}?warning/);
  });

  // The semantic trio IS the status palette under other names. These tokens
  // shipped as byte-identical COPIES of the status hexes — `--color-success`
  // was `#4ade80` and `--color-status-connected` was `#4ade80` — which held
  // only until someone retuned one of them, at which point the ~100
  // `text-success`/`text-warning`/`text-destructive` callsites would drift
  // into an eighth and ninth hue nobody chose. A var() reference makes the
  // identity structural: retuning the status token moves both, and a grep
  // for either name finds the other.
  it('success, warning and destructive alias the status tokens by reference, in both themes', () => {
    const aliases = [
      ['--color-success', '--color-status-connected'],
      ['--color-warning', '--color-status-syncing'],
      ['--color-destructive', '--color-status-disconnected'],
    ] as const;
    const themes = [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const;
    for (const [themeName, block] of themes) {
      for (const [alias, target] of aliases) {
        const m = new RegExp(`${alias}:\\s*([^;]+);`).exec(block);
        expect(m, `${alias} must be declared in ${themeName}`).not.toBeNull();
        expect(
          m![1].trim(),
          `${alias} in ${themeName} must be var(${target}) — a raw value here re-forks the semantic palette from the status palette`,
        ).toBe(`var(${target})`);
      }
    }
  });

  // Indigo (--color-info) is the one semantic hue WITHOUT a status twin, and
  // its documented role is INFORMATIONAL: a passive notice or the Confluence
  // info admonition panel — never a state, a measurement, a category chip or
  // an interactive affordance. Two consequences are pinned here: it must not
  // collide with any reserved hue (a collision is how "informational" starts
  // meaning something else), and it must read as text on the surfaces
  // notices sit on.
  it('info is its own hue — colliding with no status colour or the accent — and reads AA', () => {
    const themes = [
      ['graphite', darkBlock, { bg: '--color-background', card: '--color-card' }],
      ['paper', lightBlock, { bg: '--color-background', card: '--color-card' }],
    ] as const;
    const reserved = [
      '--color-primary',
      '--color-status-connected',
      '--color-status-syncing',
      '--color-status-embedding',
      '--color-status-ai',
      '--color-status-disconnected',
      '--color-status-inactive',
    ];
    for (const [themeName, block, surfaces] of themes) {
      const info = resolveToken(block, '--color-info');
      for (const other of reserved) {
        expect(
          info,
          `--color-info in ${themeName} must not collide with ${other}`,
        ).not.toBe(resolveToken(block, other));
      }
      for (const [name, surfaceToken] of Object.entries(surfaces)) {
        const surface = token(block, surfaceToken);
        expectContrast(`info on ${name} (${themeName})`, info, surface, 4.5);
        // The surface users actually READ an info notice on is the panel's own
        // bg-info/10 tint, not the bare surface — measure the composite too.
        expectContrast(
          `info on its own bg-info/10 panel over ${name} (${themeName})`,
          info,
          composite(info, 0.1, surface),
          4.5,
        );
      }
    }
  });

  // Full-strength info clears AA on its tinted panel; opacity-downgraded info
  // text does not — text-info/80 measured 4.11:1 and text-info/70 3.36:1 over
  // bg-info/10, both under AA at the 12px these notices use. The token maths
  // above cannot see a `/NN` modifier baked into a class string, so this scans
  // the sources — the "token guards miss baked literals" lesson.
  it('no callsite opacity-downgrades info text', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules') continue;
          walk(full, out);
        } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders = walk(__dirname)
      .filter((path) => /\btext-info\/\d+/.test(stripComments(readFileSync(path, 'utf-8'))))
      .map((path) => path.slice(__dirname.length + 1));
    expect(
      offenders,
      'text-info/NN fails AA over the bg-info/10 panel — use full-strength text-info and de-emphasise with size/weight',
    ).toEqual([]);
  });

  it('inline code resolves its own token in BOTH themes', () => {
    // Paper used to hardcode `color: oklch(0.45 0.15 25)` — a red — over its own
    // --inline-code-color (#7041a8), so the token was dead and the two themes
    // rendered different hues rather than one hue at two lightnesses.
    expect(token(darkBlock, '--inline-code-color')).toBeTruthy();
    expect(token(lightBlock, '--inline-code-color')).toBeTruthy();

    const lightInlineCode = /\[data-theme-type="light"\][^{]*\.prose[^{]*code\)[^{]*\{([^}]*)\}/.exec(css);
    expect(lightInlineCode, 'light-theme inline-code rule not found').not.toBeNull();
    expect(
      lightInlineCode![1],
      'the light theme must resolve --inline-code-color, not override it with a literal',
    ).not.toMatch(/(^|[\s;])color:/);
  });

  // The dark:-hex chip recipe. This app declares no `@custom-variant dark`, so
  // a `dark:` class compiles to the OS media query — it tracks the OS, never
  // the user's picked theme, and OS-dark + Paper rendered a dark warm-gray
  // chip on a white surface (`bg-[#ececea] … dark:bg-[#2a2925]`). The recipe
  // was cleared out of these surfaces one review at a time (EmbeddingStatusBadge
  // first, then the four survivors this list added), so the converted files are
  // pinned BY NAME: a className check inside one component's test cannot see
  // the same recipe pasted into the next file.
  it('converted surfaces carry no dark: variant and no hex-literal colour', () => {
    const files = [
      'shared/components/article/PagePreview.tsx',
      'shared/components/badges/ConfidenceBadge.tsx',
      'shared/components/badges/EmbeddingStatusBadge.tsx',
      'shared/components/badges/FreshnessBadge.tsx',
      'shared/components/badges/PageStateBadge.tsx',
      'shared/components/badges/neutral-chip.ts',
      'features/admin/LlmAuditPage.tsx',
      'features/admin/OidcSettingsPage.tsx',
      'features/admin/RbacPage.tsx',
    ];
    for (const rel of files) {
      const source = stripComments(readFileSync(resolve(__dirname, rel), 'utf-8'));
      expect(
        source.match(/\bdark:[\w[\]/#-]+/g) ?? [],
        `${rel} must not use dark: variants — they follow the OS, not the picked theme`,
      ).toEqual([]);
      expect(
        source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [],
        `${rel} must not hardcode hex colours — use the theme tokens`,
      ).toEqual([]);
    }
  });

  it('text selection is styled from the accent, in both themes', () => {
    // With no ::selection rule the editor's highest-frequency interaction
    // rendered at the UA default blue, in a palette declared neutral-plus-Steel.
    const selection = /::selection\s*\{([^}]*)\}/.exec(css);
    expect(selection, 'no ::selection rule found').not.toBeNull();
    expect(selection![1]).toMatch(/var\(--color-primary\)/);
    expect(selection![1], 'selection must not hardcode a colour').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
