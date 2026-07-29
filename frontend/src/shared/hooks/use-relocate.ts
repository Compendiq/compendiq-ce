/**
 * Relocate an article between a local space and Confluence (#1123).
 *
 * Two endpoints, both gated on the global `pages:relocate` permission:
 *   GET  /api/pages/:id/relocate/preview  — what the confirmation must state
 *   POST /api/pages/:id/relocate          — perform the move
 *
 * Backend design of record: `backend/src/routes/knowledge/pages-relocate.ts`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RelocatePageInput, RelocatePageResponse, RelocatePreview } from '@compendiq/contracts';
import { apiFetch } from '../lib/api';

/** The destination the user has chosen so far. Both fields start unset. */
export interface RelocateDestination {
  /**
   * Confluence space the article is published into. Sent **only** for a move
   * to Confluence: the preview route authorises a caller-supplied `spaceKey`
   * against `getUserAccessibleSpaces` (it feeds a space-membership
   * enumeration, so the check is deliberate), and that list holds the user's
   * role-assigned *Confluence* spaces — passing a local space key would 403
   * for anyone who is not a system admin. The `target: 'local'` branch of the
   * preview reads only the page's own space anyway, so nothing is lost.
   */
  spaceKey?: string;
  /** Standalone access model. The only field a move to local re-fetches on. */
  visibility?: 'private' | 'shared';
}

/**
 * Preview keyed on the destination, so choosing one is a genuine dependent
 * query rather than a manual refetch: the first fetch carries no destination
 * and returns generic access prose with empty principal lists, and the second
 * — keyed by the user's choice — names who actually gains and loses access.
 *
 * The key is `['pages', id, …]`-prefixed on purpose: a relocate preview is a
 * projection of live page state, so anything that invalidates `['pages']`
 * should refresh it too.
 */
export function useRelocatePreview(
  pageId: string | undefined,
  destination: RelocateDestination,
  enabled: boolean,
) {
  const { spaceKey, visibility } = destination;

  const search = new URLSearchParams();
  if (spaceKey) search.set('spaceKey', spaceKey);
  if (visibility) search.set('visibility', visibility);
  const qs = search.toString();

  return useQuery<RelocatePreview>({
    queryKey: ['pages', pageId, 'relocate-preview', { spaceKey, visibility }],
    queryFn: () => apiFetch(`/pages/${pageId}/relocate/preview${qs ? `?${qs}` : ''}`),
    enabled: enabled && !!pageId,
    // Counts and rosters are the whole point; never serve a cached answer.
    staleTime: 0,
    retry: false,
    // Keep the previous preview on screen while the destination-keyed one
    // loads. Without it the whole dialog collapses back to its loading state
    // the moment a destination is picked — the one interaction that is
    // supposed to *add* information. Only `accessChange` and `subtreeEffect`
    // depend on the destination, so the carried-over counts stay correct.
    placeholderData: (previous) => previous,
  });
}

/**
 * Perform the move. A relocate rewrites `source`, `space_key`, `confluence_id`
 * and every child's `parent_id`, so it moves the article in the list, the tree
 * and the space page counts at once — hence the broad invalidation.
 */
export function useRelocatePage() {
  const queryClient = useQueryClient();

  return useMutation<RelocatePageResponse, Error, { pageId: string; input: RelocatePageInput }>({
    mutationFn: ({ pageId, input }) =>
      apiFetch(`/pages/${pageId}/relocate`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (_data, { pageId }) => {
      // ['pages'] prefix-matches the list, the sidebar tree and the detail
      // query; the explicit detail key mirrors useResyncPage so the open
      // article refetches immediately rather than on next mount.
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['local-spaces'] });
      // Search hits carry the page's source and space; stale entries would
      // point at the old location. Lazy refetch is enough — nothing on screen
      // is a search result while the dialog is open.
      queryClient.invalidateQueries({ queryKey: ['search'], refetchType: 'none' });
    },
  });
}
