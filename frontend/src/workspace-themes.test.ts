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

/** Oklab ΔE — perceptual distance, for claims that a value step is *visible*. */
function deltaEOk(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s2,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s2,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s2,
    ] as const;
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

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

  // Paper is a near-neutral warm ramp: every surface, fill, border and ink under
  // it sits on the warm side of the hue circle. A cool grey slipping back in is
  // the regression this guards — it is what the palette was before, and one
  // stray #f7f7f8 reads as a blue patch against the rest.
  //
  // One token is NOT under the ramp: the owner pinned --app-chassis (frame, left
  // destination rail, top app header) three times on 2026-08-30, landing on
  // #fafaf9; then #f4f3f1 on 2026-08-31 when the workspace and context-rail
  // hairlines were removed — at #fafaf9 the unlined white card measured 1.044:1
  // against the frame, which is not an edge — and then #ebeae8 the same day,
  // asked for as "more gray" (1.202:1 on Pane). Asserting a hue rule on it would
  // assert the ramp over the owner's own value, so it gets the stricter check
  // instead — its exact value — which catches drift in EITHER direction rather
  // than trading one unguarded token for another. The card edge is measured in
  // app-shell-layout.test.ts; the rail's own ink floor is measured below.
  // --color-accent was pinned alongside it at #fdfdfd and is back under the ramp
  // now that the owner asked for a darker grey and a fitted palette.
  const OWNER_PINNED = {
    '--app-chassis': '#ebeae8',
  } as const;

  it('keeps the owner-pinned Paper neutral at its exact value', () => {
    for (const [name, value] of Object.entries(OWNER_PINNED)) {
      expect(token(lightBlock, name), `${name} is owner-pinned`).toBe(value);
    }
  });

  // The left destination rail paints Canvas, and its inactive labels are 12px
  // --color-muted-foreground on it — normal text, so 1.4.3 wants 4.5:1. This is
  // the constraint that sets HOW GREY the frame may go: at #ebeae8 the pair
  // measures 4.51:1, so the next step of grey has to be paid for by darkening
  // the secondary ink first. Without this guard the rail loses its labels to a
  // chassis retune nothing else in the suite would notice, because every other
  // muted-foreground measurement is taken against Pane and Raised.
  it('keeps the destination rail labels readable on the frame', () => {
    expectContrast(
      'muted foreground on Canvas (rail labels)',
      token(lightBlock, '--color-muted-foreground'),
      token(lightBlock, '--app-chassis'),
      4.5,
    );
  });

  it('keeps every other Paper neutral on the warm side of the hue circle', () => {
    const neutrals = [
      '--color-background',
      '--color-foreground',
      '--color-secondary',
      '--color-secondary-foreground',
      '--color-muted',
      '--color-muted-foreground',
      '--color-accent',
      '--color-pressed',
      '--color-selected',
      '--color-border',
      '--color-border-interactive',
      '--color-action',
      '--color-action-hover',
      '--color-code-bg',
      '--color-status-inactive',
      '--app-header-bg',
    ];
    for (const name of neutrals) {
      expect(name in OWNER_PINNED, `${name} is under the ramp, not pinned`).toBe(false);
      const hex = token(lightBlock, name);
      const [r, , b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
      expect(r, `${name} (${hex}) must be warm: red channel above blue`).toBeGreaterThan(b);
    }
  });

  // Hover, pressed and selected are THREE tokens with three values, in both
  // themes. They were one token — Graphite had accent, secondary and muted all
  // at #1c1d1d, so ΔE-OK between hover, selected, pressed and a field fill was
  // 0.0000 — which made a hovered row in a 40-deep page tree indistinguishable
  // from the current destination. Order matters as much as distinctness: each
  // state must sit FURTHER from the resting pane than the one before it, or
  // "more engaged" stops meaning "more filled".
  it('gives hover, pressed and selected their own rung in both themes', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const pane = token(block, '--color-card');
      const steps = (['--color-accent', '--color-pressed', '--color-selected'] as const).map(
        (name) => ({ name, value: token(block, name), ratio: contrast(token(block, name), pane) }),
      );
      const values = new Set(steps.map((s) => s.value));
      expect(values.size, `${theme}: ${steps.map((s) => `${s.name}=${s.value}`).join(' ')}`).toBe(3);
      for (let i = 1; i < steps.length; i++) {
        expect(
          steps[i]!.ratio,
          `${theme}: ${steps[i]!.name} (${steps[i]!.ratio.toFixed(3)}:1 on Pane) must sit further from the pane than ${steps[i - 1]!.name} (${steps[i - 1]!.ratio.toFixed(3)}:1)`,
        ).toBeGreaterThan(steps[i - 1]!.ratio);
      }
      // A state a user cannot see is not a state. 1.05 is the smallest step that
      // survives an IPS panel at 13px; Paper's hover measures 1.081.
      expect(steps[0]!.ratio, `${theme}: hover must be visible against the pane`).toBeGreaterThanOrEqual(1.05);

      // ADJACENT steps, not just ordering. Graphite shipped pressed one step off
      // hover — ΔE-OK 0.0101 at 1.024:1 — and passed every assertion above it,
      // because "distinct values in the right order" says nothing about whether a
      // human can see the difference.
      //
      // The floor is 0.014, and it is derived rather than chosen. The usable band
      // is capped at BOTH ends: hover must stay ≥1.05:1 against the pane, and the
      // deepest fill must keep the weakest ink (muted-foreground in Paper,
      // status-inactive in Graphite) at 4.5:1. In Paper that band spans ΔE-OK
      // 0.048 in total, so the best achievable minimum step is ~0.024 and the
      // shipped 0.0151 is 63% of the ceiling — pushing closer costs AA headroom
      // (the optimum lands muted-foreground at 4.51:1 and the edge at 3.19:1,
      // versus 4.54 and 3.22 today, for a gain of 0.003 nobody can see).
      // Graphite has more room and ships 0.0241 / 0.0321.
      //
      // So 0.014 sits below what the light theme can physically deliver and well
      // above what failed review. It catches a regression; it does not pretend
      // there is headroom the arithmetic does not have.
      for (let i = 1; i < steps.length; i++) {
        const d = deltaEOk(steps[i]!.value, steps[i - 1]!.value);
        expect(
          d,
          `${theme}: ${steps[i - 1]!.name} → ${steps[i]!.name} is ΔE-OK ${d.toFixed(4)} — imperceptible at 13px`,
        ).toBeGreaterThanOrEqual(0.014);
      }
    }
  });

  // `--color-muted` is a resting FIELD fill, not a state. It may share a value
  // with a state (Paper: both #ebebea) but it must never be the token a state
  // reads, which is how the four-way collapse happened in the first place.
  it('keeps the field fill off every state value', () => {
    // Paper shipped --color-muted and --color-selected both at #ebebea, so an
    // input resting inside a selected row painted the row's own value.
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const field = token(block, '--color-muted');
      for (const state of ['--color-pressed', '--color-selected'] as const) {
        expect(
          token(block, state),
          `${theme}: ${state} must not share the resting field fill (${field})`,
        ).not.toBe(field);
      }
    }
  });

  it('keeps the field fill out of the state ladder', () => {
    const navSelection = extractBlock(css, '@utility nav-selection {');
    expect(navSelection, 'nav-selection must paint the selected fill').toMatch(
      /background:\s*var\(--color-selected\)/,
    );
    expect(navSelection, 'nav-selection must keep its interactive outline').toMatch(
      /outline:\s*1px solid var\(--color-border-interactive\)/,
    );
    for (const name of ['nm-card-interactive', 'nm-icon-button', 'nm-pill-active']) {
      const block = extractBlock(css, `@utility ${name} {`);
      if (!/&:active/.test(block)) continue;
      expect(block, `${name}'s press must read --color-pressed, not the field fill`).not.toMatch(
        /&:active\s*\{[^}]*var\(--color-secondary\)/,
      );
    }
  });

  // Paper's surfaces must be four distinct steps, in this order: Canvas is the
  // frame and the deepest step, Chrome one 8-bit step above it (the two are one
  // family by intent — the frame and the panel bands should not read as separate
  // greys), Workspace above that, and Pane brightest. Canvas moved under Chrome
  // on 2026-08-31 when the workspace and rail hairlines came off and the
  // Canvas/Pane step became the whole card boundary.
  it('spaces the four Paper surfaces as an ordered ladder', () => {
    const ys = (['--app-chassis', '--app-header-bg', '--color-background', '--color-card'] as const).map(
      (name) => luminance(token(lightBlock, name)),
    );
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]!, `surface ${i} must sit above surface ${i - 1}`).toBeGreaterThan(ys[i - 1]!);
    }
  });

  // With Canvas pinned near-white and Raised sharing Pane's pure white, the
  // quiet hairline is doing work a value step used to do: it is the only thing
  // drawing the workspace card, and the overlay edge is half of what separates
  // a popover from the page. Neither may be softened back.
  it('pays for the near-white frame with a stronger hairline and overlay edge', () => {
    const pane = token(lightBlock, '--color-card');
    const hairline = contrast(token(lightBlock, '--color-border'), pane);
    expect(
      hairline,
      `Paper's hairline measures ${hairline.toFixed(3)}:1 on Pane; the near-white frame needs ≥1.35`,
    ).toBeGreaterThanOrEqual(1.35);
    const elevated = extractBlock(css, '@utility nm-card-elevated {');
    expect(elevated, 'the overlay edge must be the measured interactive token').toMatch(
      /border:\s*1px solid var\(--color-border-interactive\)/,
    );
  });

  // Selection is carried by this edge plus weight on top of the deeper fill.
  it('keeps the interactive edge legible on every state fill', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      for (const name of ['--color-accent', '--color-pressed', '--color-selected'] as const) {
        expectContrast(
          `${theme}: border-interactive on ${name}`,
          token(block, '--color-border-interactive'),
          token(block, name),
          3,
        );
      }
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
      // resolveToken, not token: `embedding` is an alias onto the body ink since
      // it left the hue vocabulary, and it must still clear AA on every ground.
      const value = resolveToken(darkBlock, `--color-status-${role}`);
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
  // A status label is read most often on a row, and rows are hovered, pressed
  // and selected. Measuring statuses against only `bg` and `card` is how
  // `--color-status-connected` sat at 4.44:1 on a hovered row while this file
  // claimed "every status clears AA" — the same blind spot the interactive-border
  // test below was widened to fix, one describe block earlier and 30 lines up.
  const statusGrounds = {
    ...surfaces,
    elevated: token(lightBlock, '--color-card-elevated'),
    chrome: token(lightBlock, '--app-header-bg'),
    chassis: token(lightBlock, '--app-chassis'),
    codeBg,
    hover: token(lightBlock, '--color-accent'),
    pressed: token(lightBlock, '--color-pressed'),
    selected: token(lightBlock, '--color-selected'),
    field: token(lightBlock, '--color-muted'),
  };

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

  it('every status colour clears AA on every ground it can land on', () => {
    for (const role of [
      'connected',
      'syncing',
      'embedding',
      'ai',
      'disconnected',
      'inactive',
    ]) {
      const value = resolveToken(lightBlock, `--color-status-${role}`);
      for (const [name, surface] of Object.entries(statusGrounds)) {
        expectContrast(`status-${role} on ${name}`, value, surface, 4.5);
      }
    }
  });

  // The informational hue is not a status but lands on the same grounds.
  it('the informational hue clears AA on every ground a status does', () => {
    const info = token(lightBlock, '--color-info');
    for (const [name, surface] of Object.entries(statusGrounds)) {
      expectContrast(`info on ${name}`, info, surface, 4.5);
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
    '--color-accent',
    '--color-pressed',
    '--color-selected',
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

  it('every operable utility keeps a 1px border that actually paints', () => {
    // This asserted only that a `border: 1px solid …` declaration existed, and
    // `nm-button-primary` satisfied it with `transparent` — which forced-colors
    // mode PRESERVES, so the primary action was the one operable control with no
    // forced edge in the mode where the edge is all that survives.
    for (const name of [
      'nm-card-interactive',
      'nm-button-ghost',
      'nm-button-primary',
      'nm-button-destructive',
      'nm-input',
      'nm-composer',
    ]) {
      const block = extractBlock(css, `@utility ${name} {`);
      const decl = /border:\s*1px\s+solid\s+([^;]+);/.exec(block);
      expect(decl, `${name} must declare a 1px border`).not.toBeNull();
      expect(
        decl![1]!.trim(),
        `${name}'s border must resolve to a colour; transparent survives forced-colors as transparent`,
      ).not.toBe('transparent');
    }
  });

  // Prose ink is a token in BOTH themes. Dark used to come from Tailwind
  // Typography's `prose-invert` class toggled in JSX, which painted #d1d5dc —
  // a colour absent from this file — and fell back to 1.75:1 light ink whenever
  // a component forgot the conditional.
  it('declares prose ink from the palette in both themes, with no invert class', () => {
    for (const type of ['light', 'dark']) {
      const block = extractBlock(css, `[data-theme-type="${type}"] .prose {`);
      expect(block, `${type} prose block must exist`).not.toBe('');
      expect(block, `${type} prose body ink must be the palette's foreground`).toMatch(
        /--tw-prose-body:\s*var\(--color-foreground\)/,
      );
      expect(block, `${type} prose links must be the palette's accent`).toMatch(
        /--tw-prose-links:\s*var\(--color-primary\)/,
      );
    }
    // A prose link is keyboard-reachable on every article page and had no ring,
    // so it inherited Chrome's UA blue at 3.02:1 in Graphite.
    expect(css, 'prose links must carry a palette focus ring').toMatch(
      /\.prose a:focus-visible[\s\S]{0,120}outline:\s*2px solid var\(--color-ring\)/,
    );
  });

  // WCAG 2.1 SC 1.4.1, technique G183: a link that is not underlined at rest
  // needs >= 3:1 against the SURROUNDING BODY TEXT. This file shipped
  // `text-decoration: none` on prose links and failed it in both themes — Steel
  // against body ink measures 2.72:1 (Paper) and 1.94:1 (Graphite) — while every
  // contrast guard passed the element, because they all measure ink-on-surface.
  //
  // The colour route is arithmetically closed: to clear 3:1 against Graphite's
  // #e7e9eb ink a link needs Y <= 0.238, which measures 3.04:1 on the dark pane
  // and is unreadable as text. So the assertion is on the DECORATION, and the
  // ink-on-ink ratio is measured only to prove the underline is load-bearing
  // rather than decorative.
  it('underlines prose links at rest, because colour alone cannot carry them', () => {
    const rule = /\.prose :where\(a\) \{([^}]*)\}/.exec(css);
    expect(rule, 'no .prose :where(a) rule found').not.toBeNull();
    const body = rule![1]!;
    expect(body, 'prose links must not be undecorated at rest').not.toMatch(
      /text-decoration:\s*none/,
    );
    expect(body, 'prose links must declare an underline at rest').toMatch(
      /text-decoration:\s*underline/,
    );
    expect(body, 'the underline colour must come from the accent token').toMatch(
      /text-decoration-color:[^;]*var\(--color-primary\)/,
    );

    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const linkVsBody = contrast(
        token(block, '--color-primary'),
        token(block, '--color-foreground'),
      );
      expect(
        linkVsBody,
        `${theme}: link vs body ink is ${linkVsBody.toFixed(2)}:1 — if this ever reaches 3:1 the underline becomes optional under G183, and this test should be revisited rather than deleted`,
      ).toBeLessThan(3);
    }
  });

  // Outlined controls take the MEASURED interactive border, not the quiet
  // hairline used for separators and pane edges.
  //
  // `nm-composer` is a deliberate owner exception as of 2026-08-31: the owner
  // asked for the assistant's input to read "like the other lines" once the
  // shell's own lines came off, which spends 1.4.11's resting non-text contrast
  // (3.836:1 → 1.414:1 in Paper) on that one surface. It is asserted here rather
  // than dropped from the list, so the exception is a decision on the record and
  // a `--color-border-interactive` restoration has to come back through this
  // test. What still carries the floor there is `:focus-within` — Steel border
  // plus a 1px ring, both ≥3:1 — which the two assertions below pin.
  it('outlined controls use the interactive border token', () => {
    for (const name of ['nm-button-ghost', 'nm-input']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} should use --color-border-interactive`).toMatch(
        /border:\s*1px\s+solid\s+var\(--color-border-interactive\)/,
      );
    }
  });

  it('the composer keeps the quiet hairline the owner asked for, and a compliant focus state', () => {
    const block = extractBlock(css, '@utility nm-composer {');
    expect(block, 'nm-composer is the owner exception: quiet hairline at rest').toMatch(
      /border:\s*1px\s+solid\s+var\(--color-border\)/,
    );
    expect(block, 'focus must swap the border to Steel').toMatch(
      /border-color:\s*var\(--color-primary\)/,
    );
    expect(block, 'focus must add a 1px ring, not only recolour the border').toMatch(
      /box-shadow:\s*0 0 0 1px var\(--color-primary\)/,
    );
    expect(block, 'the composer is a container: it takes the card radius').toMatch(
      /border-radius:\s*var\(--radius-lg\)/,
    );
  });

  // A selected segment is an operable component whose STATE must be
  // identifiable (1.4.11). Both chip utilities sit on a borderless `bg-muted`
  // track whose fill step is 1.161:1 (Paper) / 1.070:1 (Graphite), so the chip's
  // own edge is the only channel that can carry 3:1.
  it('selected segments carry the interactive edge', () => {
    for (const name of ['panel-tab-active', 'nm-pill-active']) {
      const block = extractBlock(css, `@utility ${name} {`);
      expect(block, `${name} must use --color-border-interactive`).toMatch(
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

describe('Comments do not outlive the values they describe', () => {
  // Twice now a critique has used this file's own comments as claims to verify
  // and found them stale: a ratio computed against a previous token value, and a
  // hex attributed to the wrong token. Nothing asserted them, so nothing caught
  // them. The comments are load-bearing documentation here — they explain why
  // values are what they are — so they get a guard.
  //
  // The rule: a hex mentioned inside a theme block's comments must either be a
  // value currently declared in that block, or be explicitly marked as history.
  // That is narrow on purpose. It cannot check prose ("5.58:1 on Workspace"), so
  // it does not pretend to; what it catches is the specific failure that has
  // actually happened twice — a comment naming a colour the block no longer has.
  // A sentence is history if it says so in words, carries a date (this file dates
  // every change note), or names a palette version. Without the date clause the
  // scan fires on legitimate notes like "Lifted 2026-08-31 from #71717a", which
  // is exactly the provenance worth keeping.
  const HISTORY_MARKERS =
    /\b(was|were|retired|previous|prior|used to|until|replaced|old|earlier|first|lifted|darkened|lightened|deepened|instead of|had|gave|given|pass \d|20\d\d-\d\d-\d\d|v\d\.\d)\b/i;

  for (const [theme, blockName] of [
    ['graphite', '@theme {'],
    ['paper', '[data-theme="paper"] {'],
  ] as const) {
    it(`${theme}: every hex named in a comment is either current or marked as history`, () => {
      // Include the comment immediately preceding the block: the staleness a
      // critique found twice lived in that preamble, not in the declarations.
      const at = css.indexOf(blockName);
      expect(at, `${blockName} not found`).toBeGreaterThan(-1);
      const before = css.slice(0, at);
      const preambleStart = before.lastIndexOf('/*');
      const preamble =
        preambleStart > -1 && before.indexOf('*/', preambleStart) === -1
          ? before.slice(preambleStart)
          : '';
      const block = preamble + extractBlock(css, blockName);
      const declared = new Set(
        [...block.matchAll(/:\s*(#[0-9a-fA-F]{3,8})\b/g)].map((m) => m[1]!.toLowerCase()),
      );
      const offenders: string[] = [];
      for (const comment of block.match(/\/\*[\s\S]*?\*\//g) ?? []) {
        // Sentence-ish granularity, so a marker in one clause does not excuse a
        // stale hex three sentences later.
        for (const sentence of comment.split(/(?<=[.;])\s+/)) {
          for (const m of sentence.matchAll(/(#[0-9a-fA-F]{6})\b/g)) {
            const hex = m[1]!.toLowerCase();
            if (declared.has(hex)) continue;
            if (HISTORY_MARKERS.test(sentence)) continue;
            offenders.push(`${hex} — "${sentence.replace(/\s+/g, ' ').trim().slice(0, 110)}"`);
          }
        }
      }
      expect(
        offenders,
        `${theme}: these hexes are named as current but are not declared in the block:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }
});

describe('Colour survives colour-vision deficiency', () => {
  /**
   * The guards above assert that no two semantic hues are equal, and that every
   * one clears AA. Both claims were only ever true for NORMAL vision, and the
   * file said so out loud: "[indigo] deliberately collides with no reserved
   * hue." Simulated, the old palette merged `--color-status-ai` with
   * `--color-info` at ΔE-OK 0.0148 (Graphite, protanopia) and merged a healthy
   * sync with a disabled one in Paper at 0.0380 — a claim no inequality check
   * can catch, because the two hexes were never equal.
   *
   * Machado, Oliveira & Fernandes (2009) severity-1.0 matrices, applied in
   * LINEAR light (applying them to gamma-encoded bytes is the common error and
   * understates the collapse). Distance is Euclidean in Oklab, which is
   * perceptually uniform enough for a "can these be told apart" threshold.
   */
  const CVD_MATRICES = {
    protanopia: [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
    deuteranopia: [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.011820, 0.042940, 0.968881],
    ],
    tritanopia: [
      [1.255528, -0.076749, -0.178779],
      [-0.078411, 0.930809, 0.147602],
      [0.004733, 0.691367, 0.303900],
    ],
  } as const;

  function toLinear(hex: string): [number, number, number] {
    return [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  }

  function fromLinear(lin: readonly number[]): string {
    return (
      '#' +
      lin
        .map((c) => {
          const v = Math.max(0, Math.min(1, c));
          const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
          return Math.round(Math.max(0, Math.min(1, s)) * 255)
            .toString(16)
            .padStart(2, '0');
        })
        .join('')
    );
  }

  function simulate(hex: string, kind: keyof typeof CVD_MATRICES): string {
    const lin = toLinear(hex);
    const m = CVD_MATRICES[kind];
    return fromLinear(m.map((row) => row[0]! * lin[0] + row[1]! * lin[1] + row[2]! * lin[2]));
  }

  /** Oklab coordinates, for a perceptual distance that luminance alone cannot fake. */
  function oklab(hex: string): [number, number, number] {
    const [r, g, b] = toLinear(hex);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function deltaE(a: string, b: string): number {
    const [l1, a1, b1] = oklab(a);
    const [l2, a2, b2] = oklab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  }

  // `status-embedding` is deliberately ABSENT: as of 2026-08-31 it resolves to
  // `--color-foreground`, i.e. body ink rather than a hue, so it is not a member
  // of the semantic-colour set this block reasons about. Its own guard is below.
  const ROLES = [
    'status-connected',
    'status-syncing',
    'status-ai',
    'status-disconnected',
    'status-inactive',
    'info',
  ] as const;

  const VIEWS = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'] as const;

  function palette(block: string): Record<string, string> {
    return Object.fromEntries(ROLES.map((r) => [r, token(block, `--color-${r}`)]));
  }

  function worstPair(pal: Record<string, string>, only?: readonly [string, string][]) {
    const names = Object.keys(pal);
    const pairs =
      only ??
      names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b] as [string, string]));
    let worst = { d: Infinity, label: '' };
    for (const view of VIEWS) {
      for (const [a, b] of pairs) {
        if (pal[a] === pal[b]) continue; // same token by design (embedding IS Steel)
        const x = view === 'normal' ? pal[a]! : simulate(pal[a]!, view);
        const y = view === 'normal' ? pal[b]! : simulate(pal[b]!, view);
        const d = deltaE(x, y);
        if (d < worst.d) worst = { d, label: `${view}: ${a} ↔ ${b} (${pal[a]} / ${pal[b]})` };
      }
    }
    return worst;
  }

  // The pairs that appear TOGETHER in one status strip, where confusing them
  // means misreading the health of the system: a dead sync read as healthy, a
  // disabled space read as connected.
  const SAME_STRIP: readonly [string, string][] = [
    ['status-connected', 'status-disconnected'],
    ['status-connected', 'status-inactive'],
    ['status-connected', 'status-syncing'],
    ['status-syncing', 'status-disconnected'],
    ['status-disconnected', 'status-inactive'],
    ['status-syncing', 'status-inactive'],
  ];

  it('keeps embedding out of the hue vocabulary entirely', () => {
    // It was Steel — byte-identical to --color-primary — through three critiques,
    // so ambient telemetry wore the interaction colour and collapsed onto
    // `connected` under tritanopia at ΔE-OK 0.0399. Hueless had one safe landing
    // place: pointed at a muted neutral it measured 0.0000–0.0477 from
    // status-inactive, which would have made "indexing" and "idle" the same
    // colour. Assert the alias, not a value, so the reasoning survives a retune.
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const decl = new RegExp('--color-status-embedding:\\s*([^;]+);').exec(block);
      expect(decl, `${theme} must declare --color-status-embedding`).not.toBeNull();
      expect(
        decl![1]!.trim(),
        `${theme}: embedding must resolve to the body ink, not a hue`,
      ).toBe('var(--color-foreground)');
    }
  });

  it('separates AI from an informational notice under every simulation', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const pal = palette(block);
      const worst = worstPair(pal, [['status-ai', 'info']]);
      expect(
        worst.d,
        `${theme}: AI violet and the informational hue collapse — ${worst.label} ΔE-OK ${worst.d.toFixed(4)}`,
      ).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('keeps the interactive Steel apart from the informational hue under every simulation', () => {
    // Under tritanopia both drift teal, and "passive notice" reading as
    // "clickable" is the one confusion this palette cannot afford: Steel is the
    // single interaction colour. Read `--color-primary` directly — this used to
    // be measured through `status-embedding`, which was the same value until
    // embedding stopped being a hue.
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const pal = { ...palette(block), steel: token(block, '--color-primary') };
      const worst = worstPair(pal, [['steel', 'info']]);
      expect(
        worst.d,
        `${theme}: Steel and the informational hue collapse — ${worst.label} ΔE-OK ${worst.d.toFixed(4)}`,
      ).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('holds a floor under every pair that shares a status strip', () => {
    // 0.039 is not a target, it is the measured ceiling: seven roles cannot be
    // mutually separated while every one clears 4.5:1 on a white pane, because
    // the usable Oklab L band is 0.354–0.512 and seven evenly spread roles sit
    // ΔL ≈ 0.026 apart. Paper is tuned to 0.0399 at its worst pair and Graphite
    // to 0.05+. The residue is why every status indicator also carries a
    // non-colour channel — that contract is guarded in
    // `status-non-colour-channel.test.ts`, not here.
    for (const [theme, block, floor] of [
      ['graphite', darkBlock, 0.05],
      ['paper', lightBlock, 0.039],
    ] as const) {
      const pal = palette(block);
      const worst = worstPair(pal, SAME_STRIP);
      expect(
        worst.d,
        `${theme}: ${worst.label} ΔE-OK ${worst.d.toFixed(4)} — below the ${floor} floor`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it('never lets any two semantic hues merge completely under simulation', () => {
    for (const [theme, block] of [
      ['graphite', darkBlock],
      ['paper', lightBlock],
    ] as const) {
      const worst = worstPair(palette(block));
      expect(
        worst.d,
        `${theme}: ${worst.label} ΔE-OK ${worst.d.toFixed(4)}`,
      ).toBeGreaterThanOrEqual(0.035);
    }
  });
});
