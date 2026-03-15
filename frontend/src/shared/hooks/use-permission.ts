import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

interface PermissionCheckResult {
  allowed: boolean;
}

/**
 * Check if the current user has a specific permission.
 * Uses the backend RBAC permission check endpoint with Redis caching.
 *
 * @param permission - The permission to check (e.g., 'read', 'edit', 'delete', 'manage')
 * @param resourceType - Optional resource type ('space' or 'page')
 * @param resourceId - Optional resource identifier (space key or page ID)
 */
export function usePermission(
  permission: string,
  resourceType?: 'space' | 'page',
  resourceId?: string | number,
) {
  const queryParams = new URLSearchParams({ permission });
  if (resourceType) queryParams.set('resourceType', resourceType);
  if (resourceId !== undefined) queryParams.set('resourceId', String(resourceId));

  const { data, isLoading, error } = useQuery<PermissionCheckResult>({
    queryKey: ['permissions', permission, resourceType, resourceId],
    queryFn: () => apiFetch(`/permissions/check?${queryParams.toString()}`),
    staleTime: 60_000, // Match Redis TTL (60s)
    enabled: !!permission,
  });

  return {
    allowed: data?.allowed ?? false,
    loading: isLoading,
    error,
  };
}
