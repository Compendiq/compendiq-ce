import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractBlock, composite } from './test-utils';

/**
 * The login page's decorative halo — the one declared exception to the
 * flat-surface canon (see the amendment above `@utility login-halo` in
 * index.css).
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A DOM TEST
 *
 * The halo is a `-z-10` absolutely-positioned SIBLING of the hero, painted
 * behind it inside the same `isolate` stacking context. It is not an ancestor
 * of the paragraph it darkens. Every contrast checker in reach — axe-core,
 * the five palette guard suites in this directory, and jsdom itself — resolves
 * "the background behind this text" by walking the element's ANCESTOR chain
 * until it finds a non-transparent `background-color`. That walk goes
 * paragraph -> section -> main -> layout root, finds `app-backdrop`, and
 * reports the bare chassis. The halo is on a branch the walk never enters, so
 * it is invisible to all of them; it shipped as `bg-primary opacity-[0.08]
 * blur-[120px]` on two components and no guard here so much as saw it. jsdom
 * cannot help either: it computes no layout, so it cannot know the halo's disc
 * overlaps that paragraph, and it does not implement `filter: blur()` at all.
 *
 * So this suite reasons about the PAINTED RESULT from the stylesheet's own
 * numbers instead of from a tree. It composites the halo's declared colour at
 * its declared opacity over the declared chassis, in sRGB — the space a
 * browser actually alpha-blends in — and measures the lead paragraph's muted
 * ink against that composite rather than against the bare chassis.
 *
 * WHAT IT CATCHES
 *   - The utility being deleted, renamed, or dropped from either component.
 *   - The opacity, colour, blur, radius, stacking or pointer-events being
 *     re-inlined onto the components, where the palette file cannot see them.
 *   - The utility's opacity being raised past the measured ceiling, and any
 *     arbitrary `opacity-[…]` or blur reappearing anywhere under the login
 *     directory. Named-scale state fades (`disabled:opacity-60` on a button)
 *     stay legal: those tint a control, not a surface under body copy.
 *   - A new halo hue added to the utility without being measured: the hues are
 *     READ OUT of the utility block, so a third one is measured automatically
 *     and fails if it does not clear AA over either chassis.
 *   - A retune of `--color-primary`, `--color-status-ai`, `--app-chassis` or
 *     `--color-muted-foreground` that pushes the composited ground under AA.
 *
 * WHAT IT CANNOT CATCH
 *   - Geometry. It assumes the worst case — full declared opacity directly
 *     under the paragraph — because blur falloff and disc placement are layout
 *     facts no static read can recover. Real pixels are LIGHTER than what this
 *     measures (the live Paper ground is ~#eceeef against the #ebeeef modelled
 *     here), so the guard errs strict. Moving or resizing the disc is
 *     deliberately NOT bounded: any position is already covered by the worst
 *     case.
 *   - Overlap with any ink other than `--color-muted-foreground`. The hero's
 *     other text is `--color-foreground` and large-scale display type, both
 *     with far more headroom; the lead paragraph is the binding case.
 *   - A second decorative layer stacked over the halo. Two composited layers
 *     would need a second alpha and this measures one.
 *   - Anything applied at runtime via `style={{…}}` on a different element.
 *     The halo elements themselves are checked for `style=` below.
 */

const SRC = __dirname;
const LOGIN_DIR = join(SRC, 'features/settings/login');

const css = readFileSync(join(SRC, 'index.css'), 'utf8');
const halo = extractBlock(css, '@utility login-halo {');

/**
 * The two components that paint a halo. Named rather than discovered: a login
 * variant added later without a halo is not a regression, but one of THESE
 * silently losing its `login-halo` class is exactly the drift this file exists
 * to catch, and a discovery walk would report zero offenders for it.
 */
const HALO_COMPONENTS = ['LocalLoopLogin.tsx', 'ChangeDeskLogin.tsx'] as const;

/**
 * The declared ceiling. Pinned at the shipped 0.08 rather than at the last
 * value that technically passes: at 0.09 the binding case (violet over Paper)
 * measures 4.536:1 and at 0.10 it breaches, so a ceiling set to "whatever
 * still passes" would leave the page sitting on the floor with no margin for a
 * palette retune. `the floor binds just above the ceiling` below asserts that
 * relationship instead of trusting this comment.
 */
const OPACITY_CEILING = 0.08;

/** WCAG 2.1 SC 1.4.3 for body copy at this size. */
const CONTRAST_FLOOR = 4.5;

// --- tokens -----------------------------------------------------------------

const THEME_BLOCKS = {
  // Graphite is the default theme and declares its tokens in `@theme`.
  graphite: extractBlock(css, '@theme {'),
  paper: extractBlock(css, '[data-theme="paper"] {'),
} as const;

type ThemeName = keyof typeof THEME_BLOCKS;

/** Read a `--token: #rrggbb;` declaration, failing loudly on drift. */
function token(theme: ThemeName, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(THEME_BLOCKS[theme]);
  if (!m) {
    throw new Error(`${name} is not declared as a 6-digit hex in ${theme} — this guard is stale`);
  }
  return m[1]!.toLowerCase();
}

// WCAG 2.1 relative luminance / contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// --- what the utility declares ----------------------------------------------

/**
 * Every hue the utility can paint, in declaration order: the base
 * `background-color` plus one per `&[data-halo="…"]` variant. Reading these
 * out of the block is what makes a future third hue measured rather than
 * merely allowed.
 */
function declaredHues(): { variant: string; cssVar: string }[] {
  const out: { variant: string; cssVar: string }[] = [];
  // Split the block at each nested `&[data-halo="x"] {` so a declaration is
  // attributed to the variant whose rule it sits in.
  const parts = halo.split(/&\[data-halo="([^"]+)"\]\s*\{/);
  // parts[0] is the base block; then (variant, body) pairs.
  const base = /background-color:\s*var\((--[\w-]+)\)/.exec(parts[0]!);
  if (base) out.push({ variant: 'base', cssVar: base[1]! });
  for (let i = 1; i < parts.length; i += 2) {
    const m = /background-color:\s*var\((--[\w-]+)\)/.exec(parts[i + 1]!);
    if (m) out.push({ variant: parts[i]!, cssVar: m[1]! });
  }
  return out;
}

/** The utility's own `opacity:` declaration (not a variant's). */
function declaredOpacity(): number {
  const m = /opacity:\s*([\d.]+)\s*;/.exec(halo);
  if (!m) throw new Error('@utility login-halo declares no opacity — the ceiling is unenforceable');
  return Number(m[1]);
}

// --- what the components spell ----------------------------------------------

const componentSource: Record<string, string> = Object.fromEntries(
  HALO_COMPONENTS.map((name) => [name, readFileSync(join(LOGIN_DIR, name), 'utf8')]),
);

/** Every `.tsx` under the login directory, for the dir-wide re-inlining sweep. */
const loginSources = readdirSync(LOGIN_DIR)
  .filter((n) => n.endsWith('.tsx'))
  .map((n) => ({ name: n, text: readFileSync(join(LOGIN_DIR, n), 'utf8') }));

/** Class-list values from `className="…"` and `className={`…`}`. */
function classLists(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/className="([^"]*)"/g)) out.push(m[1]!);
  for (const m of source.matchAll(/className=\{`([^`]*)`\}/g)) out.push(m[1]!);
  return out;
}

/** The self-closing element markup carrying `login-halo`, attributes included. */
function haloElements(source: string): string[] {
  return [...source.matchAll(/<div\b[^>]*\blogin-halo\b[^>]*\/>/g)].map((m) => m[0]);
}

/**
 * Classes a halo element may still carry: the utility itself, plus the
 * per-variant offsets and size, which are genuinely layout and differ between
 * the two variants. Everything else — colour, opacity, blur, radius, z-index,
 * pointer-events, `absolute` — now belongs to the utility.
 */
const POSITION_OR_SIZE =
  /^(?:(?:sm|md|lg|xl|2xl):)?(?:inset(?:-x|-y)?|top|right|bottom|left|start|end|h|w|size)-(?:\[[^\]]*\]|[\w./]+)$/;

describe('the login halo is declared by the stylesheet, not improvised in JSX', () => {
  it('@utility login-halo owns colour, opacity, blur, radius, stacking and hit-testing', () => {
    for (const [property, pattern] of [
      ['position', /position:\s*absolute\s*;/],
      ['z-index', /z-index:\s*-10\s*;/],
      ['border-radius', /border-radius:\s*9999px\s*;/],
      ['pointer-events', /pointer-events:\s*none\s*;/],
      ['background-color', /background-color:\s*var\(--color-[\w-]+\)\s*;/],
      ['opacity', /opacity:\s*[\d.]+\s*;/],
      ['filter', /filter:\s*blur\([\d.]+px\)\s*;/],
    ] as const) {
      expect(halo, `login-halo must declare ${property} — the components no longer do`).toMatch(
        pattern,
      );
    }
  });

  it('the halo colour is a palette token, never a literal', () => {
    // A raw hex here would sit outside both theme blocks and paint the same in
    // Graphite and Paper, which is the failure the token system prevents.
    expect(halo, 'no colour literals in login-halo').not.toMatch(
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|color-mix)\(/,
    );
  });

  it('both login variants paint through the utility', () => {
    for (const name of HALO_COMPONENTS) {
      const lists = classLists(componentSource[name]!).filter((l) =>
        /\blogin-halo\b/.test(l),
      );
      expect(lists, `${name} must paint its halo with login-halo`).toHaveLength(1);
    }
  });

  it('neither component re-inlines the effect on the halo element', () => {
    const offenders: string[] = [];
    for (const name of HALO_COMPONENTS) {
      const elements = haloElements(componentSource[name]!);
      // Anti-vacuity: a markup shape this regex cannot see would make the loop
      // body unreachable and every rule in it pass on nothing.
      expect(elements, `${name}: no self-closing element carrying login-halo found`).toHaveLength(
        1,
      );
      const element = elements[0]!;
      if (/\bstyle=/.test(element)) {
        offenders.push(`${name}: inline style= on the halo element`);
      }
      for (const list of classLists(element)) {
        for (const cls of list.split(/\s+/).filter(Boolean)) {
          if (cls === 'login-halo') continue;
          if (POSITION_OR_SIZE.test(cls)) continue;
          offenders.push(`${name}: ${cls}`);
        }
      }
    }
    expect(
      offenders,
      'a halo element may carry only `login-halo` plus its own offsets and size; ' +
        'colour, opacity, blur, radius, stacking and pointer-events live in index.css',
    ).toEqual([]);
  });

  it('nothing under the login directory re-inlines a blur or an arbitrary opacity', () => {
    const offenders: string[] = [];
    for (const { name, text } of loginSources) {
      for (const list of classLists(text)) {
        for (const cls of list.split(/\s+/).filter(Boolean)) {
          const utility = cls.slice(cls.lastIndexOf(':') + 1);
          // Any blur at all: the halo is the only one on this page and it is
          // declared in index.css.
          if (/^(?:backdrop-)?blur(?:-|$)/.test(utility)) offenders.push(`${name}: ${cls}`);
          // Only ARBITRARY opacity. `disabled:opacity-60` on a button is a
          // control state on a foreground element, not a surface tint, and
          // AuthPanel ships two of them legitimately. `opacity-[0.08]` is the
          // shape that hid the halo: a hand-tuned surface strength nobody could
          // find or bound.
          if (/^opacity-\[/.test(utility)) offenders.push(`${name}: ${cls}`);
        }
      }
    }
    expect(
      offenders,
      'the halo is the only blur on this page and it is declared in index.css; ' +
        'a second one here would be unmeasurable again',
    ).toEqual([]);
    // Anti-vacuity: the sweep must be reading real sources.
    expect(loginSources.length, 'no login sources found — this sweep is stale').toBeGreaterThan(3);
    expect(
      loginSources.flatMap(({ text }) => classLists(text)).length,
      'no class lists extracted — the scanner is stale',
    ).toBeGreaterThan(40);
  });

  it('every data-halo variant used in JSX is declared in the utility', () => {
    const declared = new Set(declaredHues().map((h) => h.variant));
    for (const name of HALO_COMPONENTS) {
      for (const element of haloElements(componentSource[name]!)) {
        for (const m of element.matchAll(/data-halo="([^"]*)"/g)) {
          expect(
            declared,
            `${name}: data-halo="${m[1]}" has no rule in @utility login-halo, ` +
              'so it paints the base hue and is measured as the wrong colour',
          ).toContain(m[1]);
        }
      }
    }
    // The AI variant is live; losing its declaration must fail here.
    expect(declared, 'the violet variant is in use by ChangeDeskLogin').toContain('ai');
  });
});

describe('the halo strength is bounded and the bound is measured', () => {
  it('the declared opacity stays at or below the ceiling', () => {
    const opacity = declaredOpacity();
    expect(
      opacity,
      `login-halo declares opacity ${opacity}; the measured ceiling is ${OPACITY_CEILING}. ` +
        'Deepening the halo darkens the ground under the hero paragraph — re-measure ' +
        'and move the ceiling deliberately, with the canon comment in index.css.',
    ).toBeLessThanOrEqual(OPACITY_CEILING);
  });

  it('the worst-case painted ground still clears AA for the hero lead paragraph', () => {
    const hues = declaredHues();
    const opacity = declaredOpacity();
    const measured: string[] = [];
    const failures: string[] = [];

    for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
      const chassis = token(theme, '--app-chassis');
      const ink = token(theme, '--color-muted-foreground');
      for (const { variant, cssVar } of hues) {
        const hue = token(theme, cssVar);
        // sRGB, on the raw bytes: this is how a browser alpha-blends. Modelled
        // in linear light the same halo reports ~4.83:1 for Paper, which is
        // wrong in the PERMISSIVE direction — it would pass a halo that
        // actually fails. Real pixels measure 4.699:1 at 0.07; the sRGB model
        // reproduces that.
        const ground = composite(hue, opacity, chassis);
        const ratio = contrast(ink, ground);
        measured.push(`${theme}/${variant} ${hue}@${opacity} over ${chassis} -> ${ground} = ${ratio.toFixed(3)}:1`);
        if (ratio < CONTRAST_FLOOR) failures.push(measured[measured.length - 1]!);
      }
    }

    expect(
      failures,
      `muted ink must clear ${CONTRAST_FLOOR}:1 on the HALO-COMPOSITED ground, not the ` +
        `bare chassis. All measurements:\n  ${measured.join('\n  ')}`,
    ).toEqual([]);

    // Anti-vacuity: two themes times at least two hues.
    expect(measured.length, 'the composite sweep measured too little to be a guard').toBe(
      Object.keys(THEME_BLOCKS).length * hues.length,
    );
    expect(hues.length, 'both halo hues must be read out of the utility').toBeGreaterThanOrEqual(2);
  });

  it('the floor binds just above the ceiling, so the ceiling is load-bearing', () => {
    const hues = declaredHues();
    const worst = (alpha: number) => {
      let lowest = Infinity;
      for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
        const chassis = token(theme, '--app-chassis');
        const ink = token(theme, '--color-muted-foreground');
        for (const { cssVar } of hues) {
          lowest = Math.min(lowest, contrast(ink, composite(token(theme, cssVar), alpha, chassis)));
        }
      }
      return lowest;
    };

    // The first 0.01 step at which some combination drops under AA.
    let breach = 0;
    for (let a = 0.01; a <= 0.5 + 1e-9; a += 0.01) {
      const alpha = Math.round(a * 100) / 100;
      if (worst(alpha) < CONTRAST_FLOOR) {
        breach = alpha;
        break;
      }
    }

    expect(breach, 'no opacity up to 0.5 breaches AA — the measurement is not binding').toBeGreaterThan(0);
    expect(
      breach,
      `the ceiling ${OPACITY_CEILING} is at or above the breach point ${breach}: the halo ships ` +
        'on the AA floor with no margin',
    ).toBeGreaterThan(OPACITY_CEILING);
    expect(
      breach,
      `the halo now breaches AA at ${breach}, not 0.10. The canon amendment above ` +
        '`@utility login-halo` in index.css states 0.10 — update it, and reconsider the ceiling.',
    ).toBeCloseTo(0.1, 10);
  });

  it('the halo genuinely moves the ground, so measuring the composite is not theatre', () => {
    // If the composite equalled the bare chassis, every assertion above would
    // be measuring the chassis under a different name and the whole file would
    // be decoration.
    const opacity = declaredOpacity();
    for (const theme of Object.keys(THEME_BLOCKS) as ThemeName[]) {
      const chassis = token(theme, '--app-chassis');
      for (const { variant, cssVar } of declaredHues()) {
        const ground = composite(token(theme, cssVar), opacity, chassis);
        expect(ground, `${theme}/${variant}: halo composites to the bare chassis`).not.toBe(
          chassis,
        );
      }
    }
  });
});
