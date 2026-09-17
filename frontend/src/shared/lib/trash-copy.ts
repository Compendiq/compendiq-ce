/**
 * #1636 — the confirm copy for moving a page to trash, from ONE source.
 *
 * Two surfaces open this dialog (`PageViewPage`'s `Alt+Shift+D` shortcut and
 * the article inspector's **Move to trash**), and since #1636 the action they
 * confirm is bigger than its label used to admit: trashing a page moves its
 * whole sub-article subtree with it. A user cannot decide that from a dialog
 * that says nothing about the children, and two hand-written copies guarantee
 * that one of them eventually says something else.
 *
 * The quantity is the server's `descendantCount` from `GET /api/pages/:id` —
 * live STANDALONE descendants, the page excluded, i.e. exactly the set the
 * cascade takes. It is never derived from `usePageTree()`: the tree is
 * space/visibility filtered, may still be loading, and cannot know what the
 * request will delete.
 *
 * Both call sites gate the count on the page's source
 * (`page?.source === 'standalone' ? page.descendantCount : 0`): the Confluence
 * branch of `DELETE /pages/:id` removes exactly one row and leaves its
 * sub-articles live, so a synced page would otherwise be promised a cascade the
 * request does not perform. `N = 0` is the copy for every page the cascade
 * cannot take, not only for the pages that have no children.
 *
 * An unknown count renders the N=0 copy. That state is real (the detail is
 * still in flight, or its fetch failed) and the honest fallback is the copy
 * that promises nothing extra — a guessed number would put a promise on the
 * confirm button that the request may not keep.
 */

export interface TrashConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/** The copy every dialog used before #1636, and the fallback when the count is unknown. */
const SOLE_PAGE: TrashConfirmCopy = {
  title: 'Move page to trash?',
  description: 'It can be restored from Trash for 30 days, then it is permanently deleted.',
  confirmLabel: 'Move to trash',
};

export function trashConfirmCopy(descendantCount: number | null | undefined): TrashConfirmCopy {
  // A count that is absent, non-finite or not a whole number of pages is not a
  // count this dialog can quote. Everything except a real >= 1 falls back.
  if (typeof descendantCount !== 'number' || !Number.isInteger(descendantCount) || descendantCount < 1) {
    return SOLE_PAGE;
  }

  if (descendantCount === 1) {
    return {
      title: 'Move page and its sub-article to trash?',
      description:
        'This page has 1 sub-article. Moving the page to trash also moves the sub-article. ' +
        'Both can be restored from Trash for 30 days, then they are permanently deleted.',
      confirmLabel: 'Move page and sub-article to trash',
    };
  }

  return {
    title: 'Move page and sub-articles to trash?',
    description:
      `This page has ${descendantCount} sub-articles. Moving the page to trash also moves all of them. ` +
      'They can be restored from Trash for 30 days, then they are permanently deleted.',
    confirmLabel: `Move page and ${descendantCount} sub-articles to trash`,
  };
}
