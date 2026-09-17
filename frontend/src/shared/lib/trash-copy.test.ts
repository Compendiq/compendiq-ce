/**
 * #1636 — the destructive-page confirm copy, from its single source.
 *
 * Three surfaces render it (`PageViewPage`'s `Alt+Shift+D` path, the article
 * inspector's Move to trash, and the library's bulk bar) over two cascading
 * server actions, and the model is obliged to name what each of them actually
 * costs: a trash now moves the whole sub-article subtree, and a
 * Confluence-sourced page is not trashed at all — it is deleted upstream, and
 * nothing here can bring it back.
 *
 * The single-page count comes from `GET /api/pages/:id`'s `descendantCount` —
 * the server's own answer for what the cascade will take. It is NOT derived
 * from the page tree on the client: the tree is space/visibility filtered, may
 * be mid-load, and cannot know what the delete will do. The bulk bar has no
 * such count at all, which is why its copy describes the cascade instead of
 * quoting it.
 */
import { describe, it, expect } from 'vitest';
import { bulkTrashConfirmCopy, confluenceDeleteConfirmCopy, trashConfirmCopy } from './trash-copy';

describe('trashConfirmCopy (#1636)', () => {
  /**
   * Byte-for-byte the pre-#1636 dialog, for a page with no sub-articles AND
   * for an unknown count: the detail may still be in flight or its fetch may
   * have failed, and the honest fallback is the copy that promises nothing
   * extra. A guessed number would put a promise on the confirm button that the
   * request may not keep.
   */
  it('keeps the no-cascade copy byte-identical to the pre-#1636 dialog', () => {
    const preChange = {
      title: 'Move page to trash?',
      description: 'It can be restored from Trash for 30 days, then it is permanently deleted.',
      confirmLabel: 'Move to trash',
    };
    expect(trashConfirmCopy(0)).toEqual(preChange);
    expect(trashConfirmCopy(undefined)).toEqual(preChange);
    expect(trashConfirmCopy(null)).toEqual(preChange);
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

  it('falls back to the no-cascade copy when the count is not a count of pages', () => {
    const zero = trashConfirmCopy(0);
    expect(trashConfirmCopy(Number.NaN)).toEqual(zero);
    expect(trashConfirmCopy(-3)).toEqual(zero);
    expect(trashConfirmCopy(1.5)).toEqual(zero);
  });
});

/**
 * A synced page takes the OTHER branch of `DELETE /api/pages/:id`: the delete
 * propagates up to Confluence, and afterwards `GET /pages/trash` filters
 * `source = 'standalone'` while restore refuses anything else — so the page
 * never reaches Trash and can never be restored from it. The 30-day promise
 * this copy replaces was the one sentence no later action could make true.
 */
describe('confluenceDeleteConfirmCopy (#1636)', () => {
  it('describes an irreversible upstream delete', () => {
    expect(confluenceDeleteConfirmCopy()).toEqual({
      title: 'Delete page in Confluence permanently?',
      description:
        'This page is synced from Confluence, so deleting it here deletes it in Confluence too. This cannot be undone.',
      confirmLabel: 'Delete permanently in Confluence',
    });
  });

  it('offers no recovery path, in any of the three sentences the user reads', () => {
    const copy = confluenceDeleteConfirmCopy();
    for (const line of [copy.title, copy.description, copy.confirmLabel]) {
      expect(line).not.toMatch(/trash/i);
      expect(line).not.toMatch(/30 days/i);
      expect(line).not.toMatch(/restor/i);
    }
  });
});

/**
 * `POST /pages/bulk/delete` cascades exactly like the single-page delete, so
 * confirming "Move 1 page to trash?" over a parent holding forty sub-articles
 * was an under-report by a factor of forty-one. No `descendantCount` is
 * fetched for a multi-select, so the copy states what the REQUEST does and
 * quotes only the numbers it actually knows — the selection, and how much of
 * it is Confluence-sourced.
 */
describe('bulkTrashConfirmCopy (#1636)', () => {
  it('states the cascade for a single standalone selection without inventing a total', () => {
    expect(bulkTrashConfirmCopy(1, 0)).toEqual({
      title: 'Move 1 page and any sub-articles to trash?',
      description:
        'Moving a page to trash also moves its sub-articles, so this can trash more pages than the one selected. They can be restored from Trash for 30 days, then they are permanently deleted.',
      confirmLabel: 'Move 1 page and any sub-articles to trash',
    });
  });

  it('pluralises the selection for several standalone pages', () => {
    expect(bulkTrashConfirmCopy(3, 0)).toEqual({
      title: 'Move 3 pages and any sub-articles to trash?',
      description:
        'Moving a page to trash also moves its sub-articles, so this can trash more pages than the 3 selected. They can be restored from Trash for 30 days, then they are permanently deleted.',
      confirmLabel: 'Move 3 pages and any sub-articles to trash',
    });
  });

  it('warns about the one Confluence-sourced page in a mixed selection', () => {
    expect(bulkTrashConfirmCopy(3, 1)).toEqual({
      title: 'Delete 3 selected pages?',
      description:
        'Moving a page to trash also moves its sub-articles, so this can trash more pages than the 3 selected. ' +
        'They can be restored from Trash for 30 days, then they are permanently deleted. ' +
        '1 of the selected pages is synced from Confluence: it is deleted in Confluence instead, and cannot be restored from Trash.',
      confirmLabel: 'Move 2 pages to trash and delete 1 in Confluence',
    });
  });

  it('splits the counts both ways when the mixed selection is mostly synced', () => {
    expect(bulkTrashConfirmCopy(4, 3)).toEqual({
      title: 'Delete 4 selected pages?',
      description:
        'Moving a page to trash also moves its sub-articles, so this can trash more pages than the 4 selected. ' +
        'They can be restored from Trash for 30 days, then they are permanently deleted. ' +
        '3 of the selected pages are synced from Confluence: they are deleted in Confluence instead, and cannot be restored from Trash.',
      confirmLabel: 'Move 1 page to trash and delete 3 in Confluence',
    });
  });

  /**
   * Nothing in the selection can reach Trash, so there is no trash half and no
   * cascade: mentioning either would describe work this request does not do.
   */
  it('says only the upstream truth when every selected page is synced', () => {
    expect(bulkTrashConfirmCopy(1, 1)).toEqual({
      title: 'Delete 1 page in Confluence permanently?',
      description:
        'The selected page is synced from Confluence, so deleting it here deletes it in Confluence too. This cannot be undone.',
      confirmLabel: 'Delete 1 page in Confluence',
    });
    expect(bulkTrashConfirmCopy(2, 2)).toEqual({
      title: 'Delete 2 pages in Confluence permanently?',
      description:
        'The selected pages are synced from Confluence, so deleting them here deletes them in Confluence too. This cannot be undone.',
      confirmLabel: 'Delete 2 pages in Confluence',
    });
    for (const line of Object.values(bulkTrashConfirmCopy(2, 2))) {
      expect(line).not.toMatch(/trash/i);
      expect(line).not.toMatch(/sub-article/i);
    }
  });

  /**
   * A caller that counted synced pages over the whole selection while posting
   * only the visible ids would otherwise render "5 of the 2 selected pages"
   * above a button offering to move -3 pages to trash.
   */
  it('cannot be made to quote more synced pages than were selected', () => {
    expect(bulkTrashConfirmCopy(2, 5)).toEqual(bulkTrashConfirmCopy(2, 2));
  });
});
