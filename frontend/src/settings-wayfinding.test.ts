import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { SETTINGS_PANELS } from './features/settings/settings-nav';

/**
 * Settings wayfinding must match the live rail.
 *
 * The settings IA was consolidated and renamed (LLM → AI Models, Spaces →
 * Spaces & Sync, RBAC → Access Control), and the copy that pointed at it was
 * not: frontend surfaces still said "Settings → LLM", the backend returned
 * the same stale name in error messages that land in the same toasts, one
 * pointer named a panel that renders "This settings page doesn't exist.",
 * and the user-bulk-action dialog shipped a real link to a route that 404s.
 * A signpost to a demolished street is worse than no signpost.
 *
 * This test scans frontend AND backend source — backend error strings reach
 * the user through the same toasts (`use-attachments.ts` renders
 * `err.message` beside the client-side copy), and a frontend test reading
 * backend sources is the established pattern (`nginx-api-body-limit.test.ts`).
 * Comments are scanned too, because a stale comment is how the next stale
 * copy gets written. Three checks, all against the table in settings-nav.ts:
 *
 *  1. A `Settings` chain (any arrow spelling: →, ->, &gt;, ›) must start
 *     with a live panel label or interpolate one from the table; a second
 *     hop must be a live sub-tab label OF THAT PANEL — sub-tab sets are
 *     parsed per wrapper and keyed by panel via SettingsPanelRoute.tsx, so
 *     "AI Models → Conflicts" cannot borrow another wrapper's tab name.
 *  2. A hardcoded `/settings/<a>/<b>` path must be a live panel path.
 *  3. A `?sub=` deep link must name a sub-tab id of the panel whose path it
 *     is appended to.
 *
 * The chain check is prefix-plus-boundary, not extraction: prose like
 * "Settings → AI Models and run an embedding pass" has no delimiter after
 * the label, so the text after the arrow must *begin with* a known label and
 * the next character must not be alphanumeric (so "License" cannot satisfy
 * "Licensed"). A chain split across source lines fails with an explicit
 * message rather than passing unread.
 */

const FRONTEND_SRC = resolve(__dirname);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `__fixtures__` holds sample *content* (e.g. Confluence page bodies
      // whose prose says "Settings &gt; Account") — test inputs, not app copy.
      if (entry === 'node_modules' || entry === 'dist' || entry === '__fixtures__') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = [...walk(FRONTEND_SRC), ...walk(BACKEND_SRC)].map((path) => ({
  path,
  source: readFileSync(path, 'utf-8'),
}));
const rel = (p: string) => p.slice(REPO_ROOT.length + 1);

interface Panel {
  id: string;
  label: string;
  path: string;
}
const PANELS: Panel[] = Object.entries(SETTINGS_PANELS).map(([id, p]) => ({ id, ...p }));
const PANEL_PATHS = new Set(PANELS.map((p) => p.path));
const PANEL_LABELS = PANELS.map((p) => p.label);

// ---------------------------------------------------------------------------
// Sub-tabs, keyed by the panel that renders them. The wrapper components
// declare their SubTabDef lists inline, and SettingsPanelRoute.tsx is the one
// place that says which wrapper serves which `<category>/<item>` — parse
// both rather than restating the mapping here.
// ---------------------------------------------------------------------------
const WRAPPERS_DIR = join(FRONTEND_SRC, 'features', 'settings', 'wrappers');
const panelRouteSource = readFileSync(
  join(FRONTEND_SRC, 'features', 'settings', 'SettingsPanelRoute.tsx'),
  'utf-8',
);

function wrapperByPanel(): Record<string, string> {
  const entryRe = /'[a-z-]+\/([a-z-]+)':/g;
  const entries: { itemId: string; start: number }[] = [];
  for (const m of panelRouteSource.matchAll(entryRe)) {
    entries.push({ itemId: m[1]!, start: m.index });
  }
  const map: Record<string, string> = {};
  entries.forEach((entry, i) => {
    const end = i + 1 < entries.length ? entries[i + 1]!.start : panelRouteSource.length;
    const wrapper = panelRouteSource.slice(entry.start, end).match(/<(\w+Wrapper)/);
    if (wrapper) map[entry.itemId] = wrapper[1]!;
  });
  return map;
}

interface SubTabs {
  ids: Set<string>;
  labels: string[];
}
const SUB_TABS_BY_PANEL: Record<string, SubTabs> = Object.fromEntries(
  Object.entries(wrapperByPanel()).map(([panelId, wrapperName]) => {
    const src = readFileSync(join(WRAPPERS_DIR, `${wrapperName}.tsx`), 'utf-8');
    return [
      panelId,
      {
        ids: new Set([...src.matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1]!)),
        labels: [...src.matchAll(/^\s*label:\s*'([^']+)'/gm)].map((m) => m[1]!),
      },
    ];
  }),
);

// ---------------------------------------------------------------------------
// shared/lib/routes.ts mirror constants. An interpolated chain segment may
// reference one of these instead of SETTINGS_PANELS — but only one that is
// actually exported there AND whose value is live. A name-shaped allow-list
// alone let `${BOGUS_SETTINGS_LABEL}` through: the pattern matched, the
// constant pinned nothing.
// ---------------------------------------------------------------------------
interface MirrorConstant {
  name: string;
  kind: 'LABEL' | 'PATH';
  value: string;
}
const MIRROR_CONSTANTS: MirrorConstant[] = [
  ...readFileSync(join(FRONTEND_SRC, 'shared', 'lib', 'routes.ts'), 'utf-8').matchAll(
    /export const (\w+_SETTINGS_(LABEL|PATH)) = '([^']+)'/g,
  ),
].map((m) => ({ name: m[1]!, kind: m[2]! as 'LABEL' | 'PATH', value: m[3]! }));

const MIRROR_NAME_RE = MIRROR_CONSTANTS.length
  ? new RegExp(`\\b(?:${MIRROR_CONSTANTS.map((c) => c.name).join('|')})\\b`)
  : /$^/;

// Any arrow spelling a chain might use. Bare ">" is deliberately excluded —
// JSX like `<Settings >` would false-positive.
const CHAIN_START = /Settings\s*(?:→|->|&gt;|›)\s*/;
const HOP_SPLIT = /\s*(?:→|->|&gt;|›)\s*/;

/** Label starts the text and is not followed by a letter/digit ("Licensed"). */
function matchLabel(text: string, labels: readonly string[]): string | null {
  return (
    labels.find(
      (label) => text.startsWith(label) && !/[A-Za-z0-9]/.test(text.charAt(label.length)),
    ) ?? null
  );
}

const SPLIT_LINE_FAILURE =
  'chain is split across lines — keep the whole chain on one source line so this guard can read it';

/** Returns a failure reason for one `Settings <arrow> …` chain, or null when it resolves. */
function chainFailure(chain: string): string | null {
  const hops = chain.split(HOP_SPLIT).map((h) => h.trim());
  if (hops.length > 2) {
    return `"${chain.slice(0, 60)}" has ${hops.length} hops — the settings IA is two levels deep (panel, then sub-tab)`;
  }

  const [first, second] = hops;
  if (!first) return SPLIT_LINE_FAILURE;

  let panelId: string | null = null;
  if (first.startsWith('{') || first.startsWith('$')) {
    // JSX / template-literal interpolation: fine, but only from the table —
    // SETTINGS_PANELS, or a mirror constant that routes.ts really exports
    // (whose value the "found the label sources" test holds to the table).
    if (!/SETTINGS_PANELS/.test(first) && !MIRROR_NAME_RE.test(first)) {
      return `interpolated segment "${first.slice(0, 40)}" must come from SETTINGS_PANELS or a routes.ts *_SETTINGS_LABEL/PATH export`;
    }
    const idMatch = first.match(/SETTINGS_PANELS(?:\.([a-zA-Z]+)|\[['"]([a-z-]+)['"]\])/);
    panelId = idMatch ? (idMatch[1] ?? idMatch[2]!) : null;
    if (panelId && !(panelId in SETTINGS_PANELS)) {
      return `SETTINGS_PANELS has no panel "${panelId}"`;
    }
  } else {
    const label = matchLabel(first, PANEL_LABELS);
    if (!label) {
      return `"${first.slice(0, 40)}" does not start with a live panel label (${PANEL_LABELS.join(' | ')})`;
    }
    panelId = PANELS.find((p) => p.label === label)!.id;
  }

  if (second !== undefined) {
    if (!second) return SPLIT_LINE_FAILURE;
    if (second.startsWith('{') || second.startsWith('$')) {
      return 'sub-tab names have no table export — write the label out';
    }
    if (!panelId) {
      return `cannot tell which panel "${second.slice(0, 40)}" belongs to — name the panel via SETTINGS_PANELS.<id>`;
    }
    const tabs = SUB_TABS_BY_PANEL[panelId];
    if (!tabs) {
      return `panel "${panelId}" has no sub-tabs, so "${second.slice(0, 40)}" points at nothing`;
    }
    if (!matchLabel(second, tabs.labels)) {
      return `"${second.slice(0, 40)}" is not a sub-tab of "${panelId}" (${tabs.labels.join(' | ')})`;
    }
  }
  return null;
}

describe('settings wayfinding matches the live rail', () => {
  it('found the label sources it validates against', () => {
    // If any parse comes back empty the checks below would pass vacuously.
    expect(PANEL_LABELS.length).toBeGreaterThan(0);
    expect(Object.keys(SUB_TABS_BY_PANEL).length).toBeGreaterThanOrEqual(5);
    for (const [panelId, tabs] of Object.entries(SUB_TABS_BY_PANEL)) {
      expect(panelId in SETTINGS_PANELS, `wrapper mapped to unknown panel "${panelId}"`).toBe(true);
      expect(tabs.ids.size, `no sub-tab ids parsed for "${panelId}"`).toBeGreaterThan(1);
      expect(tabs.labels.length, `no sub-tab labels parsed for "${panelId}"`).toBeGreaterThan(1);
    }
    // Files walked on both sides — an empty backend walk would silently
    // un-extend the guard.
    expect(files.some(({ path }) => path.startsWith(BACKEND_SRC))).toBe(true);
  });

  it('every routes.ts mirror constant pins a live label or path', () => {
    // The interpolation allow-list accepts these by name, so each must
    // exist and carry a value the table recognises — otherwise a plausibly
    // named constant would smuggle a dead pointer past the chain check.
    expect(MIRROR_CONSTANTS.length).toBeGreaterThan(0);
    for (const { name, kind, value } of MIRROR_CONSTANTS) {
      if (kind === 'LABEL') {
        expect(PANEL_LABELS, `${name} pins "${value}", not a live panel label`).toContain(value);
      } else {
        expect(PANEL_PATHS.has(value), `${name} pins "${value}", not a live panel path`).toBe(true);
      }
    }
  });

  it('every "Settings → …" names a live panel (and, beyond it, that panel\'s own sub-tab)', () => {
    const offences: string[] = [];
    for (const { path, source } of files) {
      source.split('\n').forEach((line, idx) => {
        for (const chain of line.split(CHAIN_START).slice(1)) {
          const failure = chainFailure(chain);
          if (failure) offences.push(`${rel(path)}:${idx + 1} — ${failure}`);
        }
      });
    }
    expect(offences, 'stale settings wayfinding copy').toEqual([]);
  });

  it('every hardcoded /settings/<category>/<item> path is a live panel path', () => {
    const offences: string[] = [];
    for (const { path, source } of files) {
      source.split('\n').forEach((line, idx) => {
        for (const m of line.matchAll(/\/settings\/[a-z0-9-]+\/[a-z0-9-]+/g)) {
          if (!PANEL_PATHS.has(m[0])) {
            offences.push(`${rel(path)}:${idx + 1} — ${m[0]}`);
          }
        }
      });
    }
    expect(offences, 'settings paths that no panel serves').toEqual([]);
  });

  it('every ?sub= deep link names a sub-tab id of the panel it is appended to', () => {
    // SubTabs silently falls back to the first visible tab for an unknown
    // ?sub=, so a renamed sub-tab id would not 404 — it would just land
    // somewhere else.
    const offences: string[] = [];
    for (const { path, source } of files) {
      source.split('\n').forEach((line, idx) => {
        for (const m of line.matchAll(/\?sub=([a-z0-9-]+)/g)) {
          const sub = m[1]!;
          const before = line.slice(0, m.index);
          const literal = before.match(/\/settings\/[a-z0-9-]+\/([a-z0-9-]+)$/);
          const dynamic = before.match(
            /SETTINGS_PANELS(?:\.([a-zA-Z]+)|\[['"]([a-z-]+)['"]\])\.path[}`]*\$?$/,
          );
          const panelId = literal ? literal[1]! : dynamic ? (dynamic[1] ?? dynamic[2]!) : null;
          const where = `${rel(path)}:${idx + 1}`;
          if (!panelId) {
            offences.push(`${where} — cannot tell which panel ?sub=${sub} belongs to`);
          } else if (!SUB_TABS_BY_PANEL[panelId]?.ids.has(sub)) {
            offences.push(`${where} — "${panelId}" has no sub-tab id "${sub}"`);
          }
        }
      });
    }
    expect(offences, 'deep links into sub-tabs that do not exist').toEqual([]);
  });
});
