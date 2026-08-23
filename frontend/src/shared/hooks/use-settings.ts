import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SettingsResponse } from '@compendiq/contracts';
import { apiFetch } from '../lib/api';

export function useSettings() {
  return useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/settings'),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Toast policy for one `useUpdateSettings()` instance (#1402).
 *
 * The options live on the HOOK, not on `mutate`'s variables: `mutationFn`
 * stringifies its argument straight into the `PUT /settings` body, so a flag
 * carried there would reach the wire and be refused by `UpdateSettingsSchema`.
 */
export interface UpdateSettingsToastOptions {
  /**
   * Skip the "Settings saved" confirmation.
   *
   * For writes the user did not submit a form for — the onboarding checklist's
   * own Dismiss/Reopen, and every background milestone auto-mark. A settings
   * panel's Save is an explicit act the user is watching for and keeps its
   * confirmation.
   */
  silent?: boolean;
  /**
   * Skip the failure toast as well. Only for writes nobody asked for.
   *
   * A background onboarding auto-mark fires seconds after the user asked an AI
   * question or saved a page; a red toast there reads as "that failed", which
   * is the opposite of the truth. The flag simply stays unset and the next
   * occurrence of the same action retries it. Never pass this for a write a
   * button started — see `silent` above.
   */
  silentErrors?: boolean;
}

/**
 * Shared `PUT /settings` mutation used by the settings panels
 * (the `SettingsPanelRoute` registry) and, silently, by the onboarding
 * checklist (`use-onboarding.ts`).
 *
 * Saving Confluence credentials also invalidates the cached page-versions
 * queries: their `backfillStatus: 'skipped_no_credentials'` hint is cached
 * for 5 minutes, so without this a user who just added a PAT would reopen
 * the version-history dialog and still be told to add one (#763 follow-up).
 */
export function useUpdateSettings({ silent, silentErrors }: UpdateSettingsToastOptions = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_data, body) => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      if ('confluenceUrl' in body || 'confluencePat' in body) {
        // ['pages', <id>, 'versions'] (list) and ['pages', <id>, 'versions', n]
        // (detail) — both depend on the viewer's Confluence credentials.
        queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === 'pages' && q.queryKey[2] === 'versions',
        });
      }
      if (!silent) toast.success('Settings saved');
    },
    onError: (err: Error) => {
      if (!silentErrors) toast.error(err.message);
    },
  });
}
