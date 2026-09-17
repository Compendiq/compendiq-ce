/**
 * #1636 — the confirm copy for every destructive page action, from ONE source.
 *
 * Three surfaces destroy pages: `PageViewPage`'s `Alt+Shift+D` shortcut, the
 * article inspector's **Move to trash**, and the library's multi-select bulk
 * bar. They confirm the same two server actions (`DELETE /api/pages/:id` and
 * `POST /api/pages/bulk/delete`), and since #1636 BOTH of those cascade: a
 * trash takes the target's whole live sub-article subtree with it. A user
 * cannot decide that from a dialog that says nothing about the children, and
 * three hand-written copies of one action guarantee that one of them
 * eventually says something else.
 *
 * `trashConfirmCopy`'s quantity is the server's `descendantCount` from
 * `GET /api/pages/:id` — live STANDALONE descendants, the page excluded, i.e.
 * exactly the set the cascade takes. It is never derived from `usePageTree()`:
 * the tree is space/visibility filtered, may still be loading, and cannot know
 * what the request will delete.
 *
 * An unknown count renders the sole-page copy. That state is real (the detail
 * is still in flight, or its fetch failed) and the honest fallback is the copy
 * that promises nothing extra — a guessed number would put a promise on the
 * confirm button that the request may not keep.
 *
 * A NON-STANDALONE page does not belong in that function at all, and used to
 * be routed through its `N = 0` branch. That branch promises a 30-day restore,
 * and for a synced page every word of it is false: the Confluence branch of
 * `DELETE /pages/:id` propagates the delete UP to Confluence (irreversible
 * there), and afterwards `GET /pages/trash` filters `source = 'standalone'`
 * while `POST /pages/:id/restore` refuses anything else — so the page NEVER
 * reaches Trash and can never be restored from it. That is what
 * `confluenceDeleteConfirmCopy` says instead, and why it names neither Trash
 * nor a window.
 *
 * `bulkTrashConfirmCopy` deliberately quotes NO cascade total. Nothing fetches
 * `descendantCount` for a multi-select — there is no per-page detail request
 * behind the bulk bar — so it describes what the request DOES (trashing a page
 * also trashes its sub-articles) rather than claiming a number the request may
 * not match.
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

/**
 * The delete of a Confluence-sourced page: an upstream removal this app cannot
 * undo and Trash never sees. Naming Trash or the 30-day window here would name
 * a recovery path that does not exist for this page.
 */
const CONFLUENCE_PAGE: TrashConfirmCopy = {
  title: 'Delete page in Confluence permanently?',
  description:
    'This page is synced from Confluence, so deleting it here deletes it in Confluence too. This cannot be undone.',
  confirmLabel: 'Delete permanently in Confluence',
};

function pageNoun(count: number): string {
  return count === 1 ? 'page' : 'pages';
}

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

/**
 * Both single-page surfaces open this instead of `trashConfirmCopy` whenever
 * the loaded page's `source` is not `'standalone'`. The delete goes upstream
 * and the row never lands in Trash, so there is no count to quote and no
 * restore to promise — only the one fact that decides the click.
 */
export function confluenceDeleteConfirmCopy(): TrashConfirmCopy {
  return CONFLUENCE_PAGE;
}

/**
 * The multi-select bulk bar's copy for `POST /pages/bulk/delete`.
 *
 * `selectedCount` is how many pages the user picked; `confluenceCount` how
 * many of those are Confluence-sourced. The route splits on exactly that
 * distinction — standalone pages are trashed together with their sub-articles,
 * Confluence-sourced ones are deleted upstream and can never be restored here
 * — so a single sentence cannot cover a mixed selection honestly.
 */
export function bulkTrashConfirmCopy(selectedCount: number, confluenceCount: number): TrashConfirmCopy {
  // `confluenceCount` is counted over the same visible rows as the ids the bar
  // posts, so today it cannot exceed them. Clamped anyway because a caller that
  // counted over the WHOLE selection while posting only the visible ids would
  // otherwise render "4 of the 3 selected pages" and a negative trash count.
  const synced = Math.min(Math.max(confluenceCount, 0), selectedCount);
  const trashed = selectedCount - synced;

  // Nothing in the selection can reach Trash, so there is no trash half and no
  // cascade to describe: the upstream delete is the whole action.
  if (trashed === 0 && synced > 0) {
    return {
      title: `Delete ${synced} ${pageNoun(synced)} in Confluence permanently?`,
      description:
        synced === 1
          ? 'The selected page is synced from Confluence, so deleting it here deletes it in Confluence too. This cannot be undone.'
          : 'The selected pages are synced from Confluence, so deleting them here deletes them in Confluence too. This cannot be undone.',
      confirmLabel: `Delete ${synced} ${pageNoun(synced)} in Confluence`,
    };
  }

  // The cascade is stated as a property of the REQUEST, never as a total: the
  // number of sub-articles that will move with the selection is not on any wire
  // this surface reads, and a made-up figure is worse than no figure.
  const cascade =
    'Moving a page to trash also moves its sub-articles, so this can trash more pages than ' +
    `${selectedCount === 1 ? 'the one selected' : `the ${selectedCount} selected`}. ` +
    'They can be restored from Trash for 30 days, then they are permanently deleted.';

  if (synced === 0) {
    // "any sub-articles", not "their sub-articles": this surface never learns
    // whether the selection HAS any, so the possessive would assert children
    // that may not exist. The finding this copy fixes was an understatement,
    // and overstating in the other direction is the same defect mirrored.
    return {
      title: `Move ${selectedCount} ${pageNoun(selectedCount)} and any sub-articles to trash?`,
      description: cascade,
      confirmLabel: `Move ${selectedCount} ${pageNoun(selectedCount)} and any sub-articles to trash`,
    };
  }

  // Mixed selection. `0 < synced < selectedCount` forces `selectedCount >= 2`,
  // so the plural "selected pages" below needs no second boundary — only the
  // synced count does.
  return {
    title: `Delete ${selectedCount} selected pages?`,
    description:
      `${cascade} ` +
      (synced === 1
        ? '1 of the selected pages is synced from Confluence: it is deleted in Confluence instead, and cannot be restored from Trash.'
        : `${synced} of the selected pages are synced from Confluence: they are deleted in Confluence instead, and cannot be restored from Trash.`),
    confirmLabel: `Move ${trashed} ${pageNoun(trashed)} to trash and delete ${synced} in Confluence`,
  };
}
