import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

/**
 * A status marker may not carry its meaning in hue alone (WCAG 1.4.1).
 *
 * Measured with Machado severity-1.0 matrices, `status-connected` and
 * `status-inactive` collapse to ΔE-OK 0.038 under deuteranopia in the light
 * theme, and `status-syncing`/`status-disconnected` to 0.040: a healthy sync
 * and a disabled item, a running sync and a failed one, render as the same warm
 * grey. Separating the hues by luminance helps, but luminance is still colour —
 * a second, non-colour channel is required, and it has to be in the markup.
 *
 * Two markers failed when this guard was written: the SCIM token dot (the
 * Expires column shows a date, never a state word, so the dot was the only
 * signal) and the content-gaps severity dot (an unlabelled column, four hues,
 * nothing else). Both now carry shape — icon, and filled-bar count — plus a
 * readable state word.
 *
 * ── What this scan CAN catch ─────────────────────────────────────────────────
 * A JSX element that (1) resolves to a status colour utility — named literally
 * in its own `className`, or through a file-local variable or config map it
 * interpolates, (2) is shaped like a dot, bar or hairline (`rounded-full`, or a
 * small/1-D `h-`/`w-`/`size-`), and (3) renders nothing at all: no text, no
 * expression, no icon — while declaring no channel of its own (`aria-hidden`,
 * `aria-label`, `role="status"` or an `sr-only` child) and having none declared
 * on the three tags that open before it (its parent chain).
 *
 * ── What it CANNOT catch ─────────────────────────────────────────────────────
 * - A hue that arrives from another module or through a prop: TypingIndicator
 *   takes `dotClassName`, and only DockPanel knows it passes the AI violet. A
 *   regression there is invisible from source and needs the component's test.
 * - Whether the *nearby text actually names the state*. It cannot: "Never" in
 *   an Expires cell and "Connected" in a status line are both just strings. So
 *   the scan deliberately does NOT accept "there is text nearby" as a channel —
 *   only an explicit a11y declaration, or a hand-reviewed entry below.
 * - Colour-only meaning carried by TEXT colour (`text-warning` on a number).
 *   Those are excluded on purpose: the glyphs differ, so the text itself is the
 *   second channel.
 * - Runtime contrast or the palette values themselves — that is
 *   `workspace-themes.test.ts`.
 */

const SRC = resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments describe the markers this guard is about — including the hues that
 * were removed — so every check runs against code, not prose. Block comments
 * are blanked rather than deleted, so reported line numbers stay real.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const STATUS_FILL =
  /\bbg-(?:success|destructive|warning|status-(?:connected|syncing|embedding|ai|disconnected|inactive))(?:\/\d+)?\b/;

/** `rounded-full`, a small square dot, or a 1-D bar: shapes that hold no text. */
const MARKER_SHAPE =
  /\b(?:rounded-full|h-[123](?:\.5)?|w-[123](?:\.5)?|size-[123](?:\.5)?|h-px|w-px|h-full|h-\[\d+px\]|w-\[\d+px\])\b/;

/** An element or an ancestor saying what it is, or saying it is not there. */
const DECLARES_CHANNEL = /aria-hidden|aria-label\s*=|role="status"/;

/**
 * Opening JSX tag, tolerating `=>`, `total > 0` and nested braces inside
 * attribute expressions — a naive `[^>]*>` stops at the first of those.
 */
const OPEN_TAG = /<([A-Za-z][\w.]*)((?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*?)(\/?)>/g;

/**
 * How many opening tags before the marker count as its scope: its parent chain,
 * plus any sibling that opened just before it. Three is enough to reach the
 * labelled wrapper in every layout in this codebase (deepest today:
 * AIThinkingBlob's two blob layers inside a `role="status"` container) and short
 * enough that an unrelated control's `aria-label` further up cannot excuse a
 * marker.
 */
const SCOPE_TAGS = 3;

interface Marker {
  file: string;
  line: number;
  attrs: string;
  /** Everything between the marker's tags; '' when self-closing. */
  children: string;
  /** Source from the third-previous opening tag up to the marker. */
  scope: string;
}

/** Ignore the class-joining helpers when reading names out of a class expression. */
const CLASS_HELPERS: Record<string, true> = { cn: true, clsx: true, twMerge: true, cva: true };

/**
 * Most dots in this codebase build their class from a name — `${color}`,
 * `cn(..., cfg.dotClass)`, `statusDotClass[status]` — so a scan that reads only
 * the literal `className` text misses them. Both markers this guard was written
 * for were of exactly that shape.
 *
 * So: take the class expression, drop every string literal from it (what remains
 * is precisely the names it interpolates), and append any file-local assignment
 * to one of those names. That resolves `const color = cond ? 'bg-destructive' :
 * …`, `dotClass: 'bg-success'` in a config map, and `statusDotClass[status]`.
 *
 * It does NOT follow a value across modules or in through props: a dot whose hue
 * arrives as a prop (TypingIndicator's `dotClassName`) is visible only to that
 * component's own test. Nor does it prove the resolved name is the one actually
 * used at runtime — the resolution is deliberately generous, because a spurious
 * candidate costs one reviewed entry while a missed one costs the guard.
 */
function resolvedClassText(code: string, attrs: string): string {
  const classExpr = attrs.match(/className\s*=\s*(?:\{[\s\S]*?\}\s*(?=\w+\s*=|\/?$)|"[^"]*")/)?.[0] ?? '';
  const names = new Set(
    [...classExpr.replace(/'[^']*'|"[^"]*"|(?<=`)[^`$]*/g, ' ').matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((m) => m[0])
      .filter((name) => !CLASS_HELPERS[name] && name !== 'className'),
  );
  let text = classExpr;
  for (const name of names) {
    for (const assignment of code.matchAll(
      new RegExp(`\\b${name}\\b\\s*[:=][^;\\n]*(?:\\n(?!\\s*\\n)[^;\\n]*){0,6}`, 'g'),
    )) {
      text += `\n${assignment[0]}`;
    }
  }
  return text;
}

function childrenOf(code: string, tag: string, bodyStart: number, selfClosing: boolean): string {
  if (selfClosing) return '';
  const boundary = new RegExp(`</?${tag}(?=[\\s/>])`, 'g');
  boundary.lastIndex = bodyStart;
  let depth = 1;
  let match = boundary.exec(code);
  while (match) {
    depth += match[0][1] === '/' ? -1 : 1;
    if (depth === 0) return code.slice(bodyStart, match.index);
    match = boundary.exec(code);
  }
  // Unbalanced (a conditional close in a template, say): fall back to a window
  // large enough to hold any real marker's children.
  return code.slice(bodyStart, bodyStart + 400);
}

function collectMarkers(): Marker[] {
  const markers: Marker[] = [];
  for (const path of walk(SRC)) {
    const code = stripComments(readFileSync(path, 'utf-8'));
    for (const match of code.matchAll(OPEN_TAG)) {
      const [, tag, attrs, slash] = match;
      // Geometry is always a literal; the hue often is not.
      if (!MARKER_SHAPE.test(attrs)) continue;
      if (!STATUS_FILL.test(resolvedClassText(code, attrs))) continue;
      const children = childrenOf(code, tag, match.index + match[0].length, slash === '/');
      // A marker renders nothing: no icon, no text, not even an expression. A
      // pill whose child is `{status}` is text, and text is its own channel.
      if (/\S/.test(children.replace(/<\/?[A-Za-z][\w.]*[\s/>]?/g, ''))) continue;
      if (/<(?:[A-Z]\w*|svg)\b/.test(children)) continue;
      const before = code.slice(0, match.index);
      const opens = [...before.matchAll(/<[A-Za-z][\w.]*(?=[\s/>])/g)];
      const scopeStart = opens.length > SCOPE_TAGS ? opens[opens.length - SCOPE_TAGS].index : 0;
      markers.push({
        file: path.slice(SRC.length + 1),
        line: before.split('\n').length,
        attrs,
        children,
        scope: code.slice(scopeStart, match.index),
      });
    }
  }
  return markers;
}

/**
 * Bare markers reviewed by hand and found compliant: redundant decoration whose
 * state is named in text the scan cannot see, because the label is a sibling
 * expression rather than a literal, or sits outside the marker's parent chain.
 * Keyed by a fragment of the marker's own class expression — stable when lines
 * move, and specific enough that a NEW bare marker in the same file still fails.
 *
 * Adding an entry means: you checked that a user who cannot tell the hues apart
 * still learns the state from the text beside it. Marking such a dot
 * `aria-hidden="true"` clears it from this list honestly; nothing else does.
 */
const REVIEWED_DECORATION: Record<string, string[]> = {
  // Timeline dot; the row it belongs to carries a "Current" pill.
  'features/pages/VersionHistory.tsx': ["version.isCurrent ? 'bg-success'"],
  // Sits immediately before the line that reads "SSO Active" / "Configured
  // (disabled)" / "Not configured".
  'features/admin/OidcSettingsPage.tsx': ["? 'bg-success'"],
  // `{cfg.label}` — "Running" / "Queued" / "Idle" / "Error" — is the dot's
  // immediate sibling inside StatusBadge.
  'features/settings/WorkersTab.tsx': ['cfg.dotClass'],
  // Same shape: `{config.label}` renders beside the dot, and the badge also
  // carries `data-status`.
  'shared/components/badges/SummaryStatusBadge.tsx': ['config.dotClass'],
};

const markers = collectMarkers();

function isReviewed(marker: Marker): boolean {
  return (REVIEWED_DECORATION[marker.file] ?? []).some((fragment) =>
    marker.attrs.includes(fragment),
  );
}

describe('a status marker never carries its meaning in hue alone', () => {
  it('finds the markers it is meant to police', () => {
    // A refactor that hides every dot behind a variable would make this file
    // silently vacuous, which is worse than a failure.
    expect(markers.length, 'scan matched nothing — this guard is stale').toBeGreaterThan(5);
  });

  it('gives every bare status marker a declared channel', () => {
    const offenders = markers
      .filter(
        (marker) =>
          !DECLARES_CHANNEL.test(marker.attrs) &&
          !/sr-only/.test(marker.children) &&
          !DECLARES_CHANNEL.test(marker.scope) &&
          !isReviewed(marker),
      )
      .map((marker) => `${marker.file}:${marker.line} ${marker.attrs.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
    expect(
      offenders,
      'a hue-only dot/bar/hairline: add an icon, a shape or fill difference, plus an sr-only name (see this file\'s header)',
    ).toEqual([]);
  });

  it('has no stale review entries', () => {
    const stale = Object.entries(REVIEWED_DECORATION).flatMap(([file, fragments]) =>
      fragments
        .filter((fragment) => !markers.some((m) => m.file === file && m.attrs.includes(fragment)))
        .map((fragment) => `${file}: ${fragment}`),
    );
    expect(stale, 'the marker moved or was fixed — drop the entry').toEqual([]);
  });
});

describe('the two markers this guard was written for keep their second channel', () => {
  const scim = stripComments(readFileSync(join(SRC, 'features/admin/ScimSettingsPage.tsx'), 'utf-8'));
  const gaps = stripComments(
    readFileSync(join(SRC, 'features/admin/analytics/ContentGapsDashboard.tsx'), 'utf-8'),
  );

  it('SCIM token state maps to three distinct icons and three words', () => {
    for (const icon of ['CheckCircle2', 'AlertTriangle', 'XCircle']) {
      expect(scim, `${icon} is the shape channel for one of the three states`).toContain(icon);
    }
    expect(scim).toMatch(/label: 'Active'/);
    expect(scim).toMatch(/label: 'Expiring soon'/);
    expect(scim).toMatch(/label: 'Expired'/);
    expect(scim, 'the state word must reach assistive tech').toMatch(/sr-only/);
    expect(scim, 'the dot this replaced must not come back').not.toMatch(
      /h-2 w-2 rounded-full/,
    );
  });

  it('content-gap severity is a bar count, not a hue, and never animation', () => {
    expect(gaps).toMatch(/SEVERITY_BARS/);
    expect(gaps).toMatch(/label: 'Severe gap'/);
    expect(gaps).toMatch(/label: 'Never scored'/);
    expect(gaps, 'the state word must reach assistive tech').toMatch(/sr-only/);
    // `prefers-reduced-motion: reduce` strips animation, so animation can never
    // be the second channel. The meter is static by construction; pin it.
    const meter = gaps.slice(gaps.indexOf('function SeverityMeter'), gaps.indexOf('export function'));
    expect(meter).not.toMatch(/animate-/);
  });
});
