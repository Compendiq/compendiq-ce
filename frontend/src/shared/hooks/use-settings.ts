import { useQuery } from '@tanstack/react-query';
import type { SettingsResponse } from '@kb-creator/contracts';
import { apiFetch } from '../lib/api';

export function useSettings() {
  return useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/settings'),
  });
}
