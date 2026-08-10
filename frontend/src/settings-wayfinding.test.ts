import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { SETTINGS_PANELS } from './features/settings/settings-nav';

/**
 * Settings wayfinding must match the live rail.
 *
 * The settings IA was consolidated and renamed (LLM → AI Models, Spaces →
 * Spaces & Sync, RBAC → Access Control), and the in-app copy that pointed at
 * it was not: three surfaces still said "Settings → LLM", five said
 * "Settings → Spaces", one pointed at "Settings → Knowledge → Graph" (a panel
 * that renders "This settings page doesn't exist."), and the user-bulk-action
 * dialog shipped a real `<a href="/settings/security/rbac">` that 404s. A
 * signpost to a demolished street is worse than no signpost.
 *
 * This test scans the source tree — comments included, because a stale
 * comment is how the next stale copy gets written — and holds every literal
 * to the table in settings-nav.ts:
 *
 *  1. `Settings → X` must start with a live panel label (or interpolate one
 *     from SETTINGS_PANELS); a second `→` hop must be a live sub-tab label.
 *  2. A hardcoded `/settings/<a>/<b>` path must be a live panel path.
 *  3. A `?sub=` deep link must name a live sub-tab id.
 *
 * The chain check is prefix-plus-boundary, not extraction: prose like
 * "Settings → AI Models and run an embedding pass" has no delimiter after the
 * label, so the text after the arrow must *begin with* a known label and the
 * next character must not be alphanumeric (so "License" cannot satisfy
 * "Licensed"). A chain split across source lines fails with an explicit
 * message rather than passing unread.
 */

const SRC = resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((path) => ({
  path,
  source: readFileSync(path, 'utf-8'),
}));
const rel = (p: string) => p.slice(SRC.length + 1);

const PANEL_LABELS = Object.values(SETTINGS_PANELS).map((p) => p.label);
const PANEL_PATHS = new Set(Object.values(SETTINGS_PANELS).map((p) => p.path));

// Sub-tab labels/ids live inline in the wrapper components as SubTabDef
// literals — parse them out rather than restating them here.
const WRAPPERS_DIR = join(SRC, 'features', 'settings', 'wrappers');
const wrapperSource = readdirSync(WRAPPERS_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => readFileSync(join(WRAPPERS_DIR, f), 'utf-8'))
  .join('\n');
const SUB_TAB_LABELS = [...wrapperSource.matchAll(/^\s*label:\s*'([^']+)'/gm)].map((m) => m[1]!);
const SUB_TAB_IDS = new Set(
  [...wrapperSource.matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1]!),
);

/** Label starts the text and is not followed by a letter/digit ("Licensed"). */
function startsWithLabel(text: string, labels: readonly string[]): boolean {
  return labels.some(
    (label) => text.startsWith(label) && !/[A-Za-z0-9]/.test(text.charAt(label.length)),
  );
}

/** Returns a failure reason for one `Settings → …` chain, or null when it resolves. */
function chainFailure(chain: string): string | null {
  const hops = chain.split('→').map((h) => h.trim());
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    if (hop === '') {
      return 'chain is split across lines — keep "Settings → <panel>" on one source line so this guard can read it';
    }
    if (hop.startsWith('{') || hop.startsWith('$')) {
      // JSX / template-literal interpolation: fine, but only from the table.
      if (!hop.includes('SETTINGS_PANELS')) {
        return `interpolated segment "${hop.slice(0, 40)}" must come from SETTINGS_PANELS`;
      }
      continue;
    }
    if (i === 0) {
      if (!startsWithLabel(hop, PANEL_LABELS)) {
        return `"${hop.slice(0, 40)}" does not start with a live panel label (${PANEL_LABELS.join(' | ')})`;
      }
    } else if (!startsWithLabel(hop, SUB_TAB_LABELS)) {
      return `"${hop.slice(0, 40)}" does not start with a live sub-tab label (${SUB_TAB_LABELS.join(' | ')})`;
    }
  }
  return null;
}

describe('settings wayfinding matches the live rail', () => {
  it('found the label sources it validates against', () => {
    // If either parse comes back empty the checks below would pass vacuously.
    expect(PANEL_LABELS.length).toBeGreaterThan(0);
    expect(SUB_TAB_LABELS.length).toBeGreaterThan(0);
    expect(SUB_TAB_IDS.size).toBeGreaterThan(0);
  });

  it('every "Settings → …" names a live panel (and, beyond it, a live sub-tab)', () => {
    const offences: string[] = [];
    for (const { path, source } of files) {
      source.split('\n').forEach((line, idx) => {
        for (const chain of line.split(/Settings\s*→\s*/).slice(1)) {
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

  it('every ?sub= deep link names a live sub-tab id', () => {
    // SubTabs silently falls back to the first tab for an unknown ?sub=, so a
    // renamed sub-tab id would not 404 — it would just land somewhere else.
    const offences: string[] = [];
    for (const { path, source } of files) {
      source.split('\n').forEach((line, idx) => {
        for (const m of line.matchAll(/\?sub=([a-z0-9-]+)/g)) {
          if (!SUB_TAB_IDS.has(m[1]!)) {
            offences.push(`${rel(path)}:${idx + 1} — ?sub=${m[1]!}`);
          }
        }
      });
    }
    expect(offences, 'deep links into sub-tabs that do not exist').toEqual([]);
  });
});
