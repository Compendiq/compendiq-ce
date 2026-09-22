import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PageGovernanceProposalResponseSchema,
  type PageGovernanceProposal,
  type PageGovernanceSignOffRequest,
} from '@compendiq/contracts';
import { apiFetch } from '../lib/api';
import { PageBaselineError, toBaselineError } from './use-page-lifecycle';

/**
 * Governed sign-off reads and mutations (#277 consuming #278).
 *
 * Every route here is served only by the Enterprise overlay and is gated on
 * the live `document_sign_off_governance` entitlement, so an expired licence
 * answers 403 and the caller renders the licence sentence rather than a
 * failure. Nothing here is optimistic: each mutation returns the proposal the
 * server committed and the page is re-read, because the freeze itself happens
 * inside the final approval and only the server knows whether it completed.
 */

export function governanceProposalKey(proposalId: string) {
  return ['page-governance-proposal', proposalId] as const;
}

export function useGovernanceProposal(proposalId: string | null | undefined, enabled: boolean) {
  return useQuery<PageGovernanceProposal, PageBaselineError>({
    queryKey: governanceProposalKey(proposalId ?? 'none'),
    enabled: Boolean(proposalId) && enabled,
    retry: false,
    queryFn: async () => {
      try {
        return PageGovernanceProposalResponseSchema.parse(
          await apiFetch(`/enterprise/page-governance/proposals/${proposalId}`),
        ).proposal;
      } catch (err) {
        throw toBaselineError(err);
      }
    },
  });
}

/**
 * All governed writes share one invalidation, because all of them can change
 * the page's own lifecycle: the last approval finalizes the freeze inside the
 * same transaction, and a withdrawal or rejection changes what the page's
 * capability fields say the viewer may do next.
 */
function useGovernanceMutation<TVariables>(
  pageId: string,
  proposalId: string | null,
  request: (variables: TVariables) => { path: string; body?: unknown },
) {
  const queryClient = useQueryClient();
  return useMutation<PageGovernanceProposal, PageBaselineError, TVariables>({
    mutationFn: async (variables) => {
      const { path, body } = request(variables);
      try {
        return PageGovernanceProposalResponseSchema.parse(
          await apiFetch(path, {
            method: 'POST',
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ).proposal;
      } catch (err) {
        throw toBaselineError(err);
      }
    },
    onSuccess: async (proposal) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pages', pageId] }),
        queryClient.invalidateQueries({ queryKey: governanceProposalKey(proposal.id) }),
        ...(proposalId && proposalId !== proposal.id
          ? [queryClient.invalidateQueries({ queryKey: governanceProposalKey(proposalId) })]
          : []),
      ]);
    },
  });
}

export function useCreateProposal(pageId: string) {
  return useGovernanceMutation<void>(pageId, null, () => ({
    path: `/enterprise/pages/${pageId}/governance/proposals`,
  }));
}

export function useApproveProposal(pageId: string, proposalId: string | null) {
  return useGovernanceMutation<PageGovernanceSignOffRequest>(pageId, proposalId, (body) => ({
    path: `/enterprise/pages/${pageId}/sign-off`,
    body,
  }));
}

export function useRejectProposal(pageId: string, proposalId: string | null) {
  return useGovernanceMutation<{ reason: string }>(pageId, proposalId, (body) => ({
    path: `/enterprise/page-governance/proposals/${proposalId}/reject`,
    body,
  }));
}

export function useWithdrawProposal(pageId: string, proposalId: string | null) {
  return useGovernanceMutation<{ reason: string }>(pageId, proposalId, (body) => ({
    path: `/enterprise/page-governance/proposals/${proposalId}/withdraw`,
    body,
  }));
}

export function useFinalizeProposal(pageId: string, proposalId: string | null) {
  return useGovernanceMutation<void>(pageId, proposalId, () => ({
    path: `/enterprise/page-governance/proposals/${proposalId}/finalize`,
  }));
}

/**
 * Operator-facing wording for the workflow's typed refusals. An unmapped
 * reason is reported as itself: a refusal nobody anticipated must not read
 * as a generic failure the user can retry their way out of.
 */
export function governanceRefusal(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case 'not_authorized':
      return 'You do not have permission for this.';
    case 'role_not_assigned':
      return 'That approval role is not assigned to you.';
    case 'role_not_required':
      return 'That role is not one this space requires.';
    case 'self_approval':
      return 'The requester and the content author cannot approve their own proposal.';
    case 'proposal_not_found':
      return 'That proposal no longer exists.';
    case 'proposal_not_open':
      return 'This proposal is no longer open for votes.';
    case 'proposal_not_approved':
      return 'This proposal is not fully approved yet.';
    case 'proposal_exists':
      return 'This article already has an open proposal.';
    case 'stale_manifest':
      return 'The article changed after this proposal was opened, so the approvals were dropped. Open a new proposal.';
    case 'requirements_changed':
      return 'The approval policy changed while you were voting, so the votes were dropped.';
    case 'requirements_missing':
      return 'This space has no approval roles configured.';
    case 'page_is_frozen':
      return 'This article is already frozen.';
    case 'page_not_found':
      return 'The proposed article no longer exists.';
    case 'space_required':
      return 'A governed article has to belong to a space.';
    case 'manifest_unavailable':
      return 'The article’s manifest could not be prepared, so nothing was proposed.';
    case 'freeze_busy':
      return 'Someone is editing this article right now, so the freeze could not complete. Ask them to save and close, then retry.';
    case 'signing_key_unavailable':
      return 'This deployment’s signing key is unavailable, so no signed evidence could be produced.';
    case 'baseline_archive_capacity_exhausted':
      return 'Retained evidence has filled this deployment’s archive. An administrator has to raise the cap — nothing is ever evicted to make room.';
    case 'proposal_page_mismatch':
      return 'That proposal belongs to another article.';
    default:
      return `Refused: ${reason}.`;
  }
}
