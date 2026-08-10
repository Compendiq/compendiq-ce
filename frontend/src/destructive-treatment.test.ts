import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

/**
 * `nm-action-destructive` is the one inline destructive treatment.
 *
 * Three of them disagreed on the surfaces the design critique looked at: the
 * editor block menu used `text-destructive` + `hover:bg-destructive/10` + a
 * destructive focus ring; the article inspector used `text-destructive/80` +
 * `hover:bg-destructive/8` + the ordinary ring; and the provider list (now
 * Settings → AI Models) used nothing at all — `Delete` was an unstyled button
 * identical in weight to
 * `Edit`, `Set default` and `Test` beside it, and its confirm step reached for
 * `text-error`, a class this project does not define, so the one moment the UI
 * meant to turn red it rendered as plain text.
 *
 * A user cannot learn "red means destructive" from three different reds and an
 * absence.
 */

const SRC = resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
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
}

/**
 * Comments describe the old treatment on purpose — including in this file's own
 * subjects — so every check runs against code, not prose.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = walk(SRC).map((path) => ({
  path,
  code: stripComments(readFileSync(path, 'utf-8')),
}));
const rel = (p: string) => p.slice(SRC.length + 1);
const codeOf = (file: string) => stripComments(readFileSync(join(SRC, file), 'utf-8'));

const UNIFIED = [
  'shared/components/article/EditorBlockMenu.tsx',
  'shared/components/article/ArticleRightPane.tsx',
  'features/settings/panels/ProviderListSection.tsx',
];

describe('one destructive treatment', () => {
  it('is defined once, as a utility', () => {
    expect(readFileSync(join(SRC, 'index.css'), 'utf-8')).toMatch(
      /@utility nm-action-destructive/,
    );
  });

  it.each(UNIFIED)('%s uses it', (file) => {
    expect(codeOf(file)).toMatch(/nm-action-destructive/);
  });

  it('has no callsite hand-rolling the pair on those surfaces', () => {
    const offenders: string[] = [];
    for (const file of UNIFIED) {
      for (const line of codeOf(file).split('\n')) {
        if (line.includes('nm-action-destructive')) continue;
        if (/(?<!hover:)\btext-destructive(\/\d+)?\b/.test(line) && /\bhover:bg-destructive\/\d+\b/.test(line)) {
          offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders, 'use nm-action-destructive instead').toEqual([]);
  });

  // `text-error` is not in the token set, so it rendered as nothing — strictly
  // worse than the wrong red, because the confirm step looked inert.
  it('never reaches for an undefined colour class', () => {
    const offenders = files
      .filter(({ code }) => /\b(text|bg|border)-error\b/.test(code))
      .map(({ path }) => rel(path));
    expect(offenders, 'text-error / bg-error / border-error resolve to nothing').toEqual([]);
  });

  /**
   * A ratchet, not a ban.
   *
   * The critique named three surfaces; the codebase has far more — filled
   * confirm buttons, quiet inline removes, icon-only chip dismissals. Some are
   * legitimately different *kinds* of destructive control and some are drift,
   * and telling them apart is a sweep of its own rather than something to
   * smuggle into this change. So: the number may fall, never rise.
   */
  it('does not grow the population of hand-rolled destructive controls', () => {
    const hand = files.flatMap(({ path, code }) =>
      code
        .split('\n')
        .filter(
          (line) =>
            !line.includes('nm-action-destructive') &&
            /(?<!hover:)\btext-destructive(\/\d+)?\b/.test(line) &&
            /\bhover:bg-destructive\/\d+\b/.test(line),
        )
        .map(() => rel(path)),
    );
    // Measured after unifying the three surfaces above: 21 lines across 14
    // files. Pinned exactly, so adding one fails rather than eating slack.
    // Lower it when you sweep more; never raise it.
    expect(hand.length).toBeLessThanOrEqual(21);
  });
});

describe('deleting a page is not promoted by collapsing the inspector', () => {
  const pane = codeOf('shared/components/article/ArticleRightPane.tsx');

  // Expanded, Delete sits behind a "Danger zone" disclosure and then a confirm
  // dialog. The collapsed rail used to raise it to a top-level icon among ten
  // unlabelled glyphs, so the safety around deleting a page became a function
  // of a layout preference.
  it('the collapsed rail carries no delete control', () => {
    const railStart = pane.indexOf('article-requality-rail-btn');
    expect(railStart, 'collapsed rail not found').toBeGreaterThan(-1);
    const rail = pane.slice(railStart, pane.indexOf('</m.div>', railStart));
    expect(rail, 'Delete is back on the collapsed rail').not.toMatch(/aria-label="Delete page"/);
  });

  it('still offers it behind the expanded Danger zone, through the same confirm', () => {
    expect(pane).toMatch(/handleDelete/);
    expect(pane).toMatch(/setConfirmTrashOpen\(true\)/);
  });
});

describe('the onboarding banner does not outrank the page', () => {
  const banner = codeOf('shared/components/banners/ConfluencePatBanner.tsx');

  // It renders on every authenticated route. As a card with a filled primary it
  // was the loudest element on screen — including on /pages/:id, where the
  // page's own primary action sat beside it at a quarter of the weight.
  it('carries no filled primary button', () => {
    expect(banner).not.toMatch(/nm-button-primary/);
  });

  it('is a strip, not a card', () => {
    expect(banner).not.toMatch(/nm-card/);
  });

  it('still names what it asks for, and still dismisses', () => {
    expect(banner).toMatch(/personal access token/);
    expect(banner).toMatch(/Configure PAT/);
    expect(banner).toMatch(/Dismiss Confluence PAT reminder/);
  });
});
