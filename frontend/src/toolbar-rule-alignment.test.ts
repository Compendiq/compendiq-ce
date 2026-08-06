import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The app's top chrome reads as ONE horizontal line running across every pane.
 * On `/pages/:id` that line is drawn by three separate elements — the sidebar's
 * nav row, the article's context strip and the inspector's tab row — and on
 * `/settings` by two. They sit in different components, in different stacking
 * contexts, and nothing in the DOM connects them: the only thing making them a
 * single line is that they all resolve to the same 48px.
 *
 * jsdom performs no layout, so no render test can see this. A misalignment is
 * also invisible in review — `py-2` next to `h-12` looks like ordinary spacing,
 * and it costs 6px. This file is therefore a source guard, the same shape as
 * `ai-scroll-chain.test.ts`: it fails by name when a row stops declaring its
 * height, naming the seam that will open.
 *
 * The two spellings are not interchangeable, and which one a row needs depends
 * on where its hairline lives:
 *
 *   `h-12` + `border-b` on the SAME element — border-box puts the 1px inside
 *   the 48, so the element measures 48 and its rule lands at 48.
 *
 *   `min-h-[calc(3rem-1px)]` — for a row whose `border-b` is on its sticky
 *   PARENT. Left at a plain `min-h-12` the parent measures 49 and its rule sits
 *   one pixel low. `min-h` rather than `h` because these strips wrap at narrow
 *   widths and a fixed height would clip the second line.
 *
 * Verified by measurement at 1440x900: all three `/pages/:id` rules and both
 * `/settings` rules report an identical `getBoundingClientRect().bottom`.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

/** Rows that carry their own hairline: the height and the border are one box. */
const SELF_BORDERED = [
  ['shared/components/layout/SidebarTreeView.tsx', "the pages rail's nav row"],
  ['shared/components/layout/SettingsSidebar.tsx', "the settings rail's nav row"],
  ['shared/components/article/ArticleRightPane.tsx', "the inspector's tab row"],
] as const;

/** Rows whose hairline is on the sticky parent, so they subtract it. */
const PARENT_BORDERED = [
  ['features/pages/PageViewPage.tsx', "the article's context strip"],
  ['features/settings/SettingsLayout.tsx', "the settings title strip"],
] as const;

describe('the 48px line across the top of every pane', () => {
  it.each(SELF_BORDERED)('%s keeps h-12 on the bordered row (%s)', (file) => {
    const src = read(file);
    const rows = src
      .split('\n')
      .filter((l) => l.includes('panel-toolbar') && l.includes('border-b'));

    expect(rows.length, `${file}: no bordered panel-toolbar row found — this guard is stale`).toBe(
      1,
    );
    expect(
      rows[0],
      `${file}: the bordered panel-toolbar row lost its h-12. It draws part of the ` +
        `single line across the top of the app; without a fixed height it collapses ` +
        `to its content and its rule stops meeting the strips beside it.`,
    ).toMatch(/\bh-12\b/);
  });

  it.each(PARENT_BORDERED)('%s subtracts the parent hairline (%s)', (file) => {
    const src = read(file);
    expect(
      src,
      `${file}: the sticky strip's inner row is no longer min-h-[calc(3rem-1px)]. ` +
        `Its border-b is on the sticky parent, so a plain min-h-12 measures 49 and ` +
        `drops this rule one pixel below the sidebar's.`,
    ).toContain('min-h-[calc(3rem-1px)]');
  });

  it('no bordered chrome row falls back to vertical padding for its height', () => {
    // `py-2` on a row that draws part of the line is the specific regression
    // this file exists to catch: it reads as ordinary spacing and lands the
    // rule 6px high. The article and settings strips legitimately keep `py-2`
    // as a floor for their wrapped second line, but only alongside the min-h.
    for (const [file] of SELF_BORDERED) {
      const row = read(file)
        .split('\n')
        .find((l) => l.includes('panel-toolbar') && l.includes('border-b'))!;
      expect(row, `${file}: bordered nav row sizes itself with py-*, not h-12`).not.toMatch(
        /\bpy-\d/,
      );
    }
  });
});
