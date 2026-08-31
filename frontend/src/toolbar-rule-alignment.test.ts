import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The app's top chrome is ONE 48px band running across every pane. On
 * `/pages/:id` it is drawn by three separate elements — the sidebar's chrome
 * row, the article's context strip and the inspector's tab row — and on
 * `/settings` by two. They sit in different components, in different stacking
 * contexts, and nothing in the DOM connects them: the only thing making them
 * one band is that they all resolve to the same 48px.
 *
 * Until 2026-08-31 they also drew a shared hairline, which is what made a
 * misalignment obvious — and what made this file necessary. The owner took
 * that rule off every pane (ADR-010 v0.9), so the seam is now invisible while
 * the misalignment is not: the panes' CONTENT still has to start on one y, and
 * a row 6px short now shows up as three near-miss first rows instead of three
 * near-miss lines. So this guard outlives the line it was written for, and it
 * gains a second job: fail if a hairline creeps back onto one of these rows,
 * because one line reinstated on its own is worse than all three.
 *
 * jsdom performs no layout, so no render test can see either fact. A
 * misalignment is also invisible in review — `py-2` next to `h-12` looks like
 * ordinary spacing, and it costs 6px. This file is therefore a source guard,
 * the same shape as `ai-scroll-chain.test.ts`: it fails by name when a row
 * stops declaring its height, naming the seam that will open.
 *
 * Two spellings, and which one a row needs depends on whether anything still
 * draws a border in its box:
 *
 *   `h-12` / `min-h-12` — the row owns the whole 48. Every unlined chrome row.
 *
 *   `min-h-[calc(3rem-1px)]` — for a row whose PARENT still draws a border, so
 *   the two must add up to 48. `SettingsLayout`'s title strip is the last of
 *   these: it is `sticky`, content scrolls under it, and bg-card on bg-card
 *   needs the line. Left at a plain `min-h-12` that parent measures 49 and its
 *   content sits one pixel low.
 *
 * Verified by measurement at 1440x900: all three `/pages/:id` rows and both
 * `/settings` rows report an identical content box height.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

/** Panes whose chrome row owns the full 48px and draws no line. */
const UNLINED = [
  ['shared/components/layout/SidebarTreeView.tsx', "the pages rail's chrome rows"],
  ['shared/components/layout/SettingsSidebar.tsx', "the settings rail's nav row"],
  ['features/ai/conversations/AiConversationsSidebar.tsx', "the conversations rail's rows"],
  ['shared/components/article/ArticleRightPane.tsx', "the inspector's tab row"],
] as const;

/** Rows whose hairline is on a sticky parent, so they subtract it. */
const PARENT_BORDERED = [
  ['features/settings/SettingsLayout.tsx', 'the settings title strip'],
] as const;

const EDIT_TOOLBAR = 'shared/components/article/EditorToolbar.tsx';

/**
 * Every quoted class string carrying `panel-toolbar`, which is how a top chrome
 * row is spelled. Reading class STRINGS rather than source lines keeps prose
 * that merely names the utility out of the set, and keeps a ternary's other
 * branch (`embedMainNav ? 'py-2' : 'panel-toolbar h-12'`) from being read as
 * this row's own classes. Footers carry `border-t` and are not chrome rows.
 */
const chromeRows = (src: string) =>
  [...src.matchAll(/'([^'\n]*panel-toolbar[^'\n]*)'|"([^"\n]*panel-toolbar[^"\n]*)"/g)]
    .map((m) => m[1] ?? m[2]!)
    .filter((classes) => !classes.includes('border-t'));

describe('the 48px chrome band across the top of every pane', () => {
  it.each(UNLINED)('%s keeps h-12 on every chrome row (%s)', (file) => {
    const rows = chromeRows(read(file));

    expect(rows.length, `${file}: no panel-toolbar chrome row found — this guard is stale`)
      .toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(
        row,
        `${file}: a chrome row lost its h-12. It is one pane's share of the 48px ` +
          `band across the top of the app; without a fixed height it collapses to ` +
          `its content and its first row stops meeting the panes beside it: ${row}`,
      ).toMatch(/\bh-12\b/);
    }
  });

  it.each(UNLINED)('%s draws no hairline under the chrome row (%s)', (file) => {
    for (const row of chromeRows(read(file))) {
      expect(
        row,
        `${file}: a chrome row reinstated its border-b. The 48px rule came off ` +
          `every pane in ADR-010 v0.9 — one pane bringing it back alone is a line ` +
          `that starts and stops mid-width: ${row}`,
      ).not.toMatch(/\bborder-b\b/);
    }
  });

  it('the article context strip is unlined and owns the full 48px', () => {
    const src = read('features/pages/PageViewPage.tsx');
    expect(src, "the article strip's read row must own the whole 48").toContain('min-h-12');
    expect(
      src,
      'the article strip is outside the scroller, so nothing may pass under it ' +
        'and it needs no hairline (ADR-010 v0.9)',
    ).not.toMatch(/w-full border-b border-border bg-card/);
  });

  it.each(PARENT_BORDERED)('%s subtracts the parent hairline (%s)', (file) => {
    const src = read(file);
    expect(
      src,
      `${file}: the sticky strip's inner row is no longer min-h-[calc(3rem-1px)]. ` +
        `Its border-b is on the sticky parent — content scrolls under it and the ` +
        `two surfaces share a colour, so that line stays — and a plain min-h-12 ` +
        `measures 49, dropping this row one pixel below the sidebar's.`,
    ).toContain('min-h-[calc(3rem-1px)]');
  });

  it('keeps the edit toolbar on the article strip’s 48px band', () => {
    // The format toolbar fills its strip's full height now that the strip
    // draws no border. NewPagePage's strip keeps its own border and is
    // therefore 49px — multi-row chrome with no 48px alignment partner.
    expect(read(EDIT_TOOLBAR)).toContain('h-12 min-h-12');
  });

  it('no chrome row falls back to vertical padding for its height', () => {
    // `py-2` on a row that carries the band is the specific regression this
    // file exists to catch: it reads as ordinary spacing and lands the row 6px
    // short. The settings strip legitimately keeps `py-2` as a floor for its
    // wrapped second line, but only alongside the min-h.
    for (const [file] of UNLINED) {
      for (const row of chromeRows(read(file))) {
        expect(row, `${file}: chrome row sizes itself with py-*, not h-12`).not.toMatch(
          /\bpy-\d/,
        );
      }
    }
  });
});
