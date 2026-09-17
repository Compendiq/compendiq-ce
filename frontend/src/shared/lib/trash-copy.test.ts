/**
 * #1636 — the trash-confirm copy, from its single source.
 *
 * Both delete surfaces (`PageViewPage`'s `Alt+Shift+D` path and the article
 * inspector's Move to trash) render this dialog, and the model is obliged to
 * name what a trash actually costs: trashing a page now moves its whole
 * sub-article subtree with it. Two hand-written copies drift the first time one
 * of them is touched, and the one that drifts is the one that under-reports a
 * destructive action.
 *
 * The count comes from `GET /api/pages/:id`'s `descendantCount` — the server's
 * own answer for what the cascade will take. It is NOT derived from the page
 * tree on the client: the tree is space/visibility filtered, may be mid-load,
 * and cannot know what the delete will do.
 */
import { describe, it, expect } from 'vitest';
import { trashConfirmCopy } from './trash-copy';

describe('trashConfirmCopy (#1636)', () => {
  it('keeps the N=0 copy byte-identical to the pre-#1636 dialog', () => {
    expect(trashConfirmCopy(0)).toEqual({
      title: 'Move page to trash?',
      description: 'It can be restored from Trash for 30 days, then it is permanently deleted.',
      confirmLabel: 'Move to trash',
    });
  });

  it('names the single sub-article and its action', () => {
    expect(trashConfirmCopy(1)).toEqual({
      title: 'Move page and its sub-article to trash?',
      description:
        'This page has 1 sub-article. Moving the page to trash also moves the sub-article. Both can be restored from Trash for 30 days, then they are permanently deleted.',
      confirmLabel: 'Move page and sub-article to trash',
    });
  });

  it('states the count and the whole cascade for N >= 2', () => {
    expect(trashConfirmCopy(2)).toEqual({
      title: 'Move page and sub-articles to trash?',
      description:
        'This page has 2 sub-articles. Moving the page to trash also moves all of them. They can be restored from Trash for 30 days, then they are permanently deleted.',
      confirmLabel: 'Move page and 2 sub-articles to trash',
    });
  });

  it('carries the same reader-facing quantity into every sentence of the N >= 2 copy', () => {
    const copy = trashConfirmCopy(7);
    expect(copy.description).toContain('7 sub-articles');
    expect(copy.confirmLabel).toBe('Move page and 7 sub-articles to trash');
  });

  /**
   * An unknown count is the page detail still loading, or a fetch that failed.
   * Guessing a number would put a promise on the button that the request may
   * not keep, so the dialog falls back to the copy that promises nothing extra.
   */
  it('falls back to the N=0 copy when the count is unknown', () => {
    const zero = trashConfirmCopy(0);
    expect(trashConfirmCopy(undefined)).toEqual(zero);
    expect(trashConfirmCopy(null)).toEqual(zero);
    expect(trashConfirmCopy(Number.NaN)).toEqual(zero);
    expect(trashConfirmCopy(-3)).toEqual(zero);
    expect(trashConfirmCopy(1.5)).toEqual(zero);
  });
});
