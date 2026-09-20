import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PageFreezeHistoryResponseSchema,
  PageFreezePreviewResponseSchema,
  PageLifecycleMutationResponseSchema,
  type FreezePageRequest,
  type PageFreezeHistoryResponse,
  type PageFreezePreviewResponse,
  type PageLifecycleState,
  type UnfreezePageRequest,
} from '@compendiq/contracts';
import { apiFetch, ApiError } from '../lib/api';

/**
 * Baseline lifecycle reads and mutations (#277).
 *
 * Two rules the components below depend on:
 *
 *   - A capability is a server fact. This module never derives `canFreeze`
 *     from `isFrozen`, and a failed or in-flight read stays UNKNOWN rather
 *     than resolving to "allowed" — the caller renders three states.
 *   - A refusal keeps its typed reason. The transport already carries the
 *     server's `reason` slug beside its prose, so a stale preview or a busy
 *     room can be answered specifically instead of as a generic failure.
 */

export class PageBaselineError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = 'PageBaselineError';
    this.status = status;
    this.reason = reason;
  }
}

function toBaselineError(err: unknown): PageBaselineError {
  if (err instanceof ApiError) {
    return new PageBaselineError(err.statusCode, err.reason ?? 'request_failed', err.message);
  }
  return new PageBaselineError(0, 'request_failed', err instanceof Error ? err.message : 'Request failed');
}

export function pageLifecycleKeys(pageId: string) {
  return {
    preview: ['page-freeze-preview', pageId] as const,
    history: ['page-freeze-history', pageId] as const,
  };
}

/**
 * The manifest preview the freeze modal shows and then sends back. It is a
 * live read on purpose: the identity the user confirms must be the identity
 * the server was told about, and a changed page has to surface as a conflict
 * rather than being frozen silently under the old digest.
 */
export function useFreezePreview(pageId: string | undefined, enabled: boolean) {
  return useQuery<PageFreezePreviewResponse, PageBaselineError>({
    queryKey: pageLifecycleKeys(pageId ?? 'none').preview,
    enabled: Boolean(pageId) && enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      try {
        return PageFreezePreviewResponseSchema.parse(
          await apiFetch(`/pages/${pageId}/freeze-preview`),
        );
      } catch (err) {
        throw toBaselineError(err);
      }
    },
  });
}

export function useFreezeHistory(pageId: string | undefined, enabled: boolean) {
  return useQuery<PageFreezeHistoryResponse, PageBaselineError>({
    queryKey: pageLifecycleKeys(pageId ?? 'none').history,
    enabled: Boolean(pageId) && enabled,
    retry: false,
    queryFn: async () => {
      try {
        return PageFreezeHistoryResponseSchema.parse(
          await apiFetch(`/pages/${pageId}/freeze-history`),
        );
      } catch (err) {
        throw toBaselineError(err);
      }
    },
  });
}

function useLifecycleMutation(
  pageId: string | undefined,
  path: 'freeze' | 'unfreeze',
) {
  const queryClient = useQueryClient();
  return useMutation<PageLifecycleState, PageBaselineError, FreezePageRequest | UnfreezePageRequest>({
    mutationFn: async (body) => {
      try {
        const response = PageLifecycleMutationResponseSchema.parse(
          await apiFetch(`/pages/${pageId}/${path}`, {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        );
        return response.state;
      } catch (err) {
        throw toBaselineError(err);
      }
    },
    onSuccess: async () => {
      // Never optimistic: the page is re-read so the badge, the editor gate
      // and the tree all follow the state the server committed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['page', pageId] }),
        queryClient.invalidateQueries({ queryKey: ['pages'] }),
        queryClient.invalidateQueries({ queryKey: pageLifecycleKeys(pageId ?? 'none').history }),
      ]);
    },
  });
}

export function useFreezePage(pageId: string | undefined) {
  return useLifecycleMutation(pageId, 'freeze');
}

export function useUnfreezePage(pageId: string | undefined) {
  return useLifecycleMutation(pageId, 'unfreeze');
}

/**
 * Operator-facing wording for a typed denial. A reason with no entry here is
 * reported as itself rather than as a cheerful default — an unknown refusal
 * must not read as "you can do this".
 */
export function denialExplanation(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case 'baseline_creation_disabled':
      return 'Freezing is switched off for this deployment.';
    case 'standalone_article_required':
      return 'Only local articles can be frozen.';
    case 'confluence_integration_enabled':
      return 'Turn off the Confluence integration for your account before freezing.';
    case 'deployment_not_ready':
      return 'This deployment is not ready to freeze articles yet.';
    case 'not_authorized':
      return 'You do not have permission for this.';
    case 'page_is_frozen':
      return 'This article is already frozen.';
    case 'page_not_frozen':
      return 'This article is not frozen.';
    case 'freeze_busy':
      return 'Someone is editing this article right now. Ask them to save and close, then try again.';
    case 'governance_required':
      return 'This space requires approvals; a direct freeze is not available.';
    case 'governance_unavailable':
      return 'The approval workflow could not be reached, so freezing is unavailable.';
    case 'approval_required':
      return 'The required approvals are not complete.';
    case 'stale_manifest':
      return 'The article changed since this preview was taken.';
    case 'stale_lifecycle':
      return 'The article lifecycle changed since this view loaded.';
    default:
      return `Refused: ${reason}.`;
  }
}
