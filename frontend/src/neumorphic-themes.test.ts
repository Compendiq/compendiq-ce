import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { extractBlock } from './test-utils';
import {
  THEMES,
  THEME_IDS,
  LIGHT_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
} from './stores/theme-store';

/**
 * Regression tests for the Slate Steel + Frost Steel palette — the mineral
 * ink-and-paper system that replaced the Graphite Honey + Honey Linen pair.
 *
 * The load-bearing half of this file is `describe('Measured contrast')`: it
 * parses the real token values out of index.css and COMPUTES WCAG contrast
 * ratios rather than asserting hex strings. The previous version pinned
 * literals, which passed for any value someone typed and only ever caught
 * "this changed", never "this became unreadable". Retuning a surface here
 * fails loudly and specifically — with the measured ratio in the message.
 */

const cssPath = resolve(__dirname, 'index.css');
const css = readFileSync(cssPath, 'utf-8');

const darkBlock = extractBlock(css, '@theme {');
const lightBlock = extractBlock(css, '[data-theme="frost-steel"] {');
const lightSharedBlock = extractBlock(css, '[data-theme-type="light"] {');
const lightHeaderBlock = extractBlock(css, '[data-theme-type="light"] .app-header {');
const lightSidebarBlock = extractBlock(css, '[data-theme-type="light"] .app-sidebar {');
const lightSearchBlock = extractBlock(css, '[data-theme-type="light"] .app-search {');
const lightSelectionBlock = extractBlock(css, '[data-theme-type="light"] .nav-selection {');
const panelContextBlock = extractBlock(css, '@utility panel-context {');
const lightPanelContextBlock = extractBlock(css, '[data-theme-type="light"] .panel-context {');
const lightPanelTabBlock = extractBlock(css, '[data-theme-type="light"] .panel-tab-active {');

/** Read the first colour stop of a `--token: linear-gradient(…)` declaration. */
function gradientTop(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*linear-gradient\\([^)]*?(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`gradient not found (or has no hex stop): ${name}`);
  return m[1].toLowerCase();
}

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

describe('Theme store ships exactly Slate Steel + Frost Steel', () => {
  it('THEMES has two entries', () => {
    expect(THEMES).toHaveLength(2);
    expect(THEME_IDS).toHaveLength(2);
  });

  it('default dark theme is slate-steel', () => {
    expect(DEFAULT_DARK_THEME).toBe('slate-steel');
  });

  it('default light theme is frost-steel', () => {
    expect(DEFAULT_LIGHT_THEME).toBe('frost-steel');
  });

  it('exposes slate-steel as a dark theme', () => {
    const dark = THEMES.find((t) => t.id === 'slate-steel');
    expect(dark).toBeDefined();
    expect(dark!.category).toBe('dark');
  });

  it('exposes frost-steel as a light theme', () => {
    const light = THEMES.find((t) => t.id === 'frost-steel');
    expect(light).toBeDefined();
    expect(light!.category).toBe('light');
  });

  it('LIGHT_THEMES contains only frost-steel', () => {
    expect(LIGHT_THEMES.size).toBe(1);
    expect(LIGHT_THEMES.has('frost-steel')).toBe(true);
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
      'graphite-honey',
      'honey-linen',
    ];
    for (const id of retired) {
      expect(ids).not.toContain(id);
    }
  });

  it('theme labels match the spec', () => {
    expect(THEMES.find((t) => t.id === 'slate-steel')!.label).toBe('Slate Steel');
    expect(THEMES.find((t) => t.id === 'frost-steel')!.label).toBe('Frost Steel');
  });

  it('descriptions use the slate / steel vocabulary', () => {
    const dark = THEMES.find((t) => t.id === 'slate-steel')!;
    const light = THEMES.find((t) => t.id === 'frost-steel')!;
    expect(dark.description.toLowerCase()).toMatch(/slate|steel|navy|neumorph/);
    expect(light.description.toLowerCase()).toMatch(/frost|steel|cool|neumorph/);
  });

  // The picker chip is the only way users preview a theme before applying it,
  // so chip ↔ rendered-surface drift is a UX bug. Both chips are pulled from
  // index.css and compared, rather than pinned as literals in two places.
  it('preview chips match the rendered surfaces for BOTH themes', () => {
    const cases = [
      { id: 'slate-steel', block: darkBlock },
      { id: 'frost-steel', block: lightBlock },
    ] as const;

    for (const { id, block } of cases) {
      const meta = THEMES.find((t) => t.id === id)!;
      expect(meta.preview.bg.toLowerCase()).toBe(token(block, '--color-background'));
      expect(meta.preview.card.toLowerCase()).toBe(token(block, '--color-card'));
      expect(meta.preview.primary.toLowerCase()).toBe(token(block, '--color-primary'));
    }
  });
});

describe('Measured contrast — Slate Steel (dark)', () => {
  const bg = token(darkBlock, '--color-background');
  const card = token(darkBlock, '--color-card');
  const elevated = token(darkBlock, '--color-card-elevated');
  const codeBg = token(darkBlock, '--color-code-bg');

  // A pane gradient's LIGHTEST stop is the worst case for text on that pane:
  // anything legible there is legible at the darker bottom too. Both pane
  // gradients are checked — `nm-card-elevated` paints its own, one step up,
  // so it is a strictly worse surface than the card gradient.
  const cardGradientTop = gradientTop(darkBlock, '--surface-card');
  const elevatedGradientTop = gradientTop(darkBlock, '--surface-card-elevated');

  const surfaces = { bg, card, elevated, cardGradientTop, elevatedGradientTop };

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

  it('steel reads as text on every surface (fill and ink are one value here)', () => {
    const ink = token(darkBlock, '--color-primary-ink');
    for (const [name, surface] of Object.entries({ bg, card, elevated })) {
      expectContrast(`primary-ink on ${name}`, ink, surface, 4.5);
    }
  });

  it('ink on the primary fill clears AA, including the gradient end stop', () => {
    const ink = token(darkBlock, '--color-primary-foreground');
    expectContrast('primary-foreground on primary', ink, token(darkBlock, '--color-primary'), 4.5);
    expectContrast(
      'primary-foreground on gradient-end',
      ink,
      token(darkBlock, '--color-primary-gradient-end'),
      4.5,
    );
  });

  it('ink on the destructive fill clears AA', () => {
    expectContrast(
      'destructive-foreground on destructive',
      token(darkBlock, '--color-destructive-foreground'),
      token(darkBlock, '--color-destructive'),
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
      const value = token(darkBlock, `--color-status-${role}`);
      expectContrast(`status-${role} on background`, value, bg, 4.5);
      expectContrast(`status-${role} on card`, value, card, 4.5);
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

  // WCAG 1.4.11: the boundary of an operable control needs 3:1. The neumorphic
  // recipe leans on shadow for depth, and forced-colors mode discards shadow —
  // this border is what survives, so it is the one that has to measure up.
  it('the interactive border clears the 3:1 non-text floor on every surface', () => {
    const border = token(darkBlock, '--color-border-interactive');
    for (const [name, surface] of Object.entries(surfaces)) {
      expectContrast(`border-interactive on ${name}`, border, surface, 3);
    }
  });
});

describe('Measured contrast — Frost Steel (light)', () => {
  const bg = token(lightBlock, '--color-background');
  const card = token(lightBlock, '--color-card');
  const codeBg = token(lightBlock, '--color-code-bg');

  it('body and muted text clear AA on background and card', () => {
    for (const role of ['--color-foreground', '--color-muted-foreground']) {
      const value = token(lightBlock, role);
      expectContrast(`${role} on background`, value, bg, 4.5);
      expectContrast(`${role} on card`, value, card, 4.5);
    }
  });

  // Unlike dark, the light theme keeps a DARKENED steel for text: --color-primary
  // itself sits too close to the 4.5:1 floor on a near-white surface to be used
  // as body-size type. This asserts the split is real and still doing its job.
  it('primary-ink is a distinct, darker value than the primary fill', () => {
    const ink = token(lightBlock, '--color-primary-ink');
    const fill = token(lightBlock, '--color-primary');
    expect(ink).not.toBe(fill);
    expect(luminance(ink)).toBeLessThan(luminance(fill));
    expectContrast('primary-ink on background', ink, bg, 4.5);
    expectContrast('primary-ink on card', ink, card, 4.5);
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
      expectContrast(`status-${role} on background`, value, bg, 4.5);
      expectContrast(`status-${role} on card`, value, card, 4.5);
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
    expectContrast('border-interactive on background', border, bg, 3);
    expectContrast('border-interactive on card', border, card, 3);
  });
});

describe('Both themes declare a complete, symmetric token set', () => {
  // A token present in dark but missing in light silently falls back to the
  // dark value — which is how a light theme ends up with one navy surface.
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

  it('defines neumorphic shadow tokens in both themes', () => {
    for (const block of [darkBlock, lightSharedBlock]) {
      expect(block).toMatch(/--nm-shadow-out/);
      expect(block).toMatch(/--nm-shadow-in/);
      expect(block).toMatch(/--nm-highlight/);
    }
  });

  it('defines the gradient chassis in both themes', () => {
    for (const block of [darkBlock, lightSharedBlock]) {
      expect(block).toMatch(/--surface-backdrop:\s*radial-gradient\(/);
      expect(block).toMatch(/--surface-card:\s*linear-gradient\(/);
      expect(block).toMatch(/--surface-card-elevated:\s*linear-gradient\(/);
    }
  });

  // Without its own gradient, `nm-card-elevated` resolves --surface-card and
  // renders identically to `nm-card` — the elevation collapses into the shadow
  // and --color-card-elevated becomes unreachable through that utility.
  it('the elevated pane gradient is distinct from the card gradient', () => {
    for (const block of [darkBlock, lightSharedBlock]) {
      const card = /--surface-card:\s*([^;]+);/.exec(block)![1].trim();
      const elevated = /--surface-card-elevated:\s*([^;]+);/.exec(block)![1].trim();
      expect(elevated).not.toBe(card);
    }
  });

  // The retired recipe tinted the light shadow warm brown (rgb 50/42/20) to sit
  // under a honey accent. On a cool palette that reads as a stain.
  it('uses the mineral ink shadow tint, not the retired warm brown', () => {
    expect(lightSharedBlock).not.toMatch(/rgba\(\s*50,\s*42,\s*20/);
    expect(lightSharedBlock).toMatch(/rgba\(\s*23,\s*36,\s*34/);
  });
});

describe('Light mode has its own shell composition', () => {
  it('keeps the header on an opaque paper surface', () => {
    expect(lightHeaderBlock).toMatch(/var\(--color-card\) 96%/);
    expect(lightHeaderBlock).toMatch(/box-shadow:\s*none/);
  });

  it('sets the sidebar one value step below the reading canvas', () => {
    expect(lightSidebarBlock).toMatch(/var\(--color-background\) 84%/);
    expect(lightSidebarBlock).toMatch(/var\(--color-muted\)/);
  });

  it('gives the search control an AA-visible interactive edge', () => {
    expect(lightSearchBlock).toMatch(/border-color:\s*var\(--color-border-interactive\)/);
  });

  it('uses a quieter selection dose than the dark shell', () => {
    expect(lightSelectionBlock).toMatch(/var\(--color-primary\)[^;]*\/ 0\.09/);
    expect(lightSelectionBlock).toMatch(/outline-color:/);
  });

  it('keeps the workspace selector visibly interactive in both themes', () => {
    expect(panelContextBlock).toMatch(/border:\s*1px solid var\(--color-border-interactive\)/);
    expect(lightPanelContextBlock).toMatch(/var\(--color-card\) 94%/);
  });

  it('lifts the active inspector tab above the paper rail', () => {
    expect(lightPanelTabBlock).toMatch(/background:\s*var\(--color-card\)/);
    expect(lightPanelTabBlock).toMatch(/box-shadow:/);
  });
});

describe('Retired palettes leave no residue', () => {
  it('no retired data-theme blocks remain', () => {
    const retired = [
      'void-indigo',
      'obsidian-violet',
      'polar-slate',
      'parchment-glow',
      'ember-dusk',
      'sunrise-cream',
      'graphite-honey',
      'honey-linen',
    ];
    for (const id of retired) {
      const re = new RegExp(`\\[data-theme="${id}"\\]\\s*\\{`);
      expect(css).not.toMatch(re);
    }
  });

  // Honey survived in the CSS as literals rather than as a named theme, so a
  // block-name check alone would miss a stray brand value left behind.
  it('no honey brand hexes survive in the theme blocks', () => {
    const honey = ['#f9c74f', '#fdd56d', '#f2b72e', '#8a6016', '#ece9e2', '#121212'];
    for (const value of honey) {
      expect(darkBlock.toLowerCase()).not.toContain(value);
      expect(lightBlock.toLowerCase()).not.toContain(value);
    }
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
    'nm-button-destructive',
    'nm-icon-button',
    'nm-input',
    'nm-card-hover',
  ] as const;

  const interactive = [
    'nm-card-interactive',
    'nm-button-ghost',
    'nm-icon-button',
    'nm-input',
  ];

  for (const name of expectedUtilities) {
    it(`defines @utility ${name}`, () => {
      const re = new RegExp(`@utility\\s+${name}\\s*\\{`);
      expect(css).toMatch(re);
    });
  }

  it('every interactive utility carries a 1px hybrid border (WCAG 1.4.11)', () => {
    for (const name of [...interactive, 'nm-button-primary', 'nm-button-destructive']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block).not.toBe('');
      expect(block).toMatch(/border:\s*1(?:\.\d+)?(?:px|\.5px)?\s+solid|border:\s*1\.5px\s+solid/);
    }
  });

  // The two filled buttons are excluded on purpose: their border is derived
  // from their own fill (`oklch(from var(--color-primary) …)`) so the edge
  // tracks the button, not the page. Every other operable surface takes the
  // measured --color-border-interactive rather than the quiet hairline.
  it('outlined interactive utilities use the interactive border token', () => {
    for (const name of interactive) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} should use --color-border-interactive`).toMatch(
        /border:\s*1(?:\.5)?px\s+solid\s+var\(--color-border-interactive\)/,
      );
    }
  });

  it('content panes paint the card gradient, chrome stays flat', () => {
    for (const name of ['nm-card', 'nm-card-elevated', 'nm-card-interactive']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} should paint --surface-card`).toMatch(/var\(--surface-card/);
    }
    for (const name of ['nm-sidebar', 'nm-header', 'nm-toolbar']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} is chrome and should stay flat`).not.toMatch(/--surface-card/);
    }
  });

  it('nm-card-elevated paints the elevated gradient, not the card one', () => {
    const block = extractBlock(css, '@utility nm-card-elevated {');
    expect(block).toMatch(/background:\s*var\(--surface-card-elevated/);
  });

  // The card surfaces are background IMAGES, so a `hover:bg-*` utility — which
  // only sets background-color — is painted underneath and does nothing at all.
  // nm-card-hover is the supported way to tint one; it composes an extra image
  // layer on top. This guards the silent-no-op, not the styling choice.
  it('nm-card-hover tints via background-image, not background-color', () => {
    const block = extractBlock(css, '@utility nm-card-hover {');
    expect(block).toMatch(/&:hover/);
    expect(block).toMatch(/background-image:/);
    expect(block).not.toMatch(/background-color:/);
  });

  it('every interactive utility has a :focus-visible rule', () => {
    for (const name of [...interactive, 'nm-button-primary', 'nm-button-destructive']) {
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

describe('Typography is the Space Grotesk / Inter / JetBrains Mono system', () => {
  it('display, sans and mono stacks are declared', () => {
    expect(darkBlock).toMatch(/--font-display:\s*'Space Grotesk Variable'/);
    expect(darkBlock).toMatch(/--font-sans:\s*'Inter Variable'/);
    expect(darkBlock).toMatch(/--font-mono:\s*'JetBrains Mono Variable'/);
  });

  // `font-synthesis: style` (see font-rendering.test.ts) forbids the browser
  // from faking a weight it was not given. Tailwind's preflight resets headings
  // to `font-weight: inherit`, so a bare <h1> asks for 400 and prose h1 for 800
  // — with static cuts those silently snap to whichever weights were imported.
  // Every face must therefore be variable.
  it('imports only variable faces, so no weight can silently snap', () => {
    const imports = [...css.matchAll(/@import\s+"(@fontsource[^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec, `${spec} is a static cut — use the @fontsource-variable package`).toMatch(
        /^@fontsource-variable\//,
      );
    }
  });

  it('headings resolve the display face, not the body face', () => {
    const headingRule = /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6,[\s\S]{0,160}?\{([\s\S]*?)\}/.exec(css);
    expect(headingRule).not.toBeNull();
    expect(headingRule![1]).toMatch(/font-family:\s*var\(--font-display\)/);
  });

  it('the retired Newsreader / IBM Plex faces are no longer imported', () => {
    expect(css).not.toMatch(/newsreader/i);
    expect(css).not.toMatch(/ibm-plex-sans/i);
  });
});

describe('No component tints a card surface with a background-color utility', () => {
  /**
   * The bug this guards: `nm-card` used to be a flat `background: var(--color-card)`,
   * so a Tailwind `hover:bg-*` utility on the same element overrode it and the
   * hover worked. The moment the card surface became a gradient — a background
   * *image* — those utilities began painting underneath it and silently stopped
   * doing anything. Nothing failed; the hover just quietly disappeared.
   *
   * Card-surfaced elements must use `nm-card-hover` (which composes its tint as
   * an image layer) instead. This walks the real source rather than trusting a
   * reviewer to spot the combination.
   */
  const CARD_UTILITIES = ['nm-card', 'nm-card-elevated', 'nm-card-interactive'];

  function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) collectSourceFiles(full, acc);
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  it('no .tsx combines a card utility with hover:bg-* / group-hover:bg-*', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(__dirname)) {
      const source = readFileSync(file, 'utf-8');
      // Look at each className-ish string literal in isolation, so a card
      // utility in one attribute and a hover tint in another do not false-positive.
      for (const [literal] of source.matchAll(/(['"`])[^'"`\n]*\1/g)) {
        const usesCard = CARD_UTILITIES.some((u) =>
          new RegExp(`(^|[\\s'"\`])${u}([\\s'"\`]|$)`).test(literal),
        );
        if (usesCard && /(^|\s)(group-)?hover:bg-/.test(literal)) {
          offenders.push(`${file.replace(__dirname, 'src')}: ${literal}`);
        }
      }
    }

    expect(
      offenders,
      `card-surfaced elements cannot be tinted with a background-color utility — ` +
        `use nm-card-hover instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // nm-card-hover restates the card gradient as its lower layer, so pairing it
  // with a utility that repaints the surface puts the card gradient back over
  // that surface on hover. They are alternatives per state, not layers — which
  // is why CommentsSidebar picks between them with a ternary.
  it('no class string applies nm-card-hover and nm-pill-active together', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(__dirname)) {
      const source = readFileSync(file, 'utf-8');
      for (const [literal] of source.matchAll(/(['"`])[^'"`\n]*\1/g)) {
        if (literal.includes('nm-card-hover') && literal.includes('nm-pill-active')) {
          offenders.push(`${file.replace(__dirname, 'src')}: ${literal}`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
