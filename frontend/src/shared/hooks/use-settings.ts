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
 * Shared `PUT /settings` mutation used by both settings UIs
 * (`SettingsPage` tabs and the `SettingsPanelRoute` registry).
 *
 * Saving Confluence credentials also invalidates the cached page-versions
 * queries: their `backfillStatus: 'skipped_no_credentials'` hint is cached
 * for 5 minutes, so without this a user who just added a PAT would reopen
 * the version-history dialog and still be told to add one (#763 follow-up).
 */
export function useUpdateSettings() {
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
      toast.success('Settings saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
