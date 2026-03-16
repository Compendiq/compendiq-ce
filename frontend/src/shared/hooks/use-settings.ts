import { useQuery } from '@tanstack/react-query';
import type { SettingsResponse } from '@atlasmind/contracts';
import { apiFetch } from '../lib/api';

export function useSettings() {
  return useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/settings'),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
