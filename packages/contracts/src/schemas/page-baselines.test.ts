import { describe, expect, it } from 'vitest';
import {
  FreezePageRequestSchema,
  PageBaselineEvidenceSchema,
  PageFreezeDetailFieldsSchema,
  PageFreezeHistoryEntrySchema,
  PageFreezePreviewResponseSchema,
  PageGovernanceProposalResponseSchema,
  PageLifecycleDenialReasonSchema,
} from './page-baselines.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ACTOR_ID = '123e4567-e89b-42d3-a456-426614174001';
const DIGEST = 'a'.repeat(64);

describe('page baseline contracts', () => {
  it('accepts an exact freeze preview and refuses ambiguous revision and digest encodings', () => {
    const preview = {
      baselineId: ID,
      pageId: 7,
      version: 3,
      contentRevision: '12',
      manifestVersion: 1,
      manifestDigest: DIGEST,
      attachments: [],
      totalBytes: 0,
    };

    expect(PageFreezePreviewResponseSchema.parse(preview)).toEqual(preview);
    expect(PageFreezePreviewResponseSchema.safeParse({ ...preview, contentRevision: '012' }).success).toBe(false);
    expect(PageFreezePreviewResponseSchema.safeParse({ ...preview, manifestDigest: DIGEST.toUpperCase() }).success).toBe(false);
  });

  it('requires an explicit reason and exact optimistic concurrency inputs', () => {
    expect(FreezePageRequestSchema.safeParse({
      reason: 'Approved immutable record',
      expectedContentRevision: '12',
      expectedManifestDigest: DIGEST,
    }).success).toBe(true);
    expect(FreezePageRequestSchema.safeParse({
      reason: ' no ',
      expectedContentRevision: '12',
      expectedManifestDigest: DIGEST,
    }).success).toBe(false);
    expect(FreezePageRequestSchema.safeParse({
      reason: 'Approved immutable record',
      expectedContentRevision: '12',
      expectedManifestDigest: DIGEST,
      baselineId: ID,
    }).success).toBe(false);
  });

  it('types standalone eligibility refusals in lifecycle detail', () => {
    expect(PageLifecycleDenialReasonSchema.parse('standalone_article_required'))
      .toBe('standalone_article_required');
    expect(PageLifecycleDenialReasonSchema.parse('confluence_integration_enabled'))
      .toBe('confluence_integration_enabled');

    const state = {
      isFrozen: false,
      baselineId: null,
      frozenVersion: null,
      frozenAt: null,
      frozenBy: null,
      frozenByName: null,
      freezeReason: null,
      provenance: null,
      contentRevision: '0',
      lifecycleRevision: '0',
      canFreeze: false,
      freezeDeniedReason: 'confluence_integration_enabled',
      canUnfreeze: false,
      unfreezeDeniedReason: 'page_not_frozen',
      canApprove: false,
      approveDeniedReason: 'confluence_integration_enabled',
      canMutateContent: true,
      mutateContentDeniedReason: null,
      governanceEnabled: false,
      governanceProposalStatus: 'none',
      governanceProposalId: null,
    };
    expect(PageFreezeDetailFieldsSchema.parse(state)).toEqual(state);

    // An ungoverned space and a governed space with no proposal both report
    // status `none`, so the shared frontend cannot infer the mode from it:
    // the flag and the proposal identity are separate server facts, and both
    // are required rather than optional.
    expect(PageFreezeDetailFieldsSchema.safeParse({
      ...state, governanceEnabled: undefined,
    }).success).toBe(false);
    expect(PageFreezeDetailFieldsSchema.safeParse({
      ...state, governanceProposalId: 'not-a-uuid',
    }).success).toBe(false);
    expect(PageFreezeDetailFieldsSchema.parse({
      ...state, governanceEnabled: true, governanceProposalId: ID,
    }).governanceProposalId).toBe(ID);
  });

  it('parses a finalized governed proposal and an approved one whose freeze failed', () => {
    const proposal = {
      id: ID,
      pageId: 7,
      originalPageId: 7,
      spaceKey: 'LOCAL',
      status: 'finalized',
      expectedManifestDigest: DIGEST,
      expectedContentRevision: '12',
      requirementsRevision: '3',
      requiredRoles: ['quality'],
      requestedBy: ACTOR_ID,
      requestedByName: 'Example Admin',
      contentAuthorName: 'Example Admin',
      baselineId: ID,
      finalizeError: null,
      decisionReason: null,
      createdAt: '2026-09-18T12:00:00.000Z',
      updatedAt: '2026-09-18T12:05:00.000Z',
      approvals: [],
    };
    // The overlay answers `finalized` once the last approval froze the page;
    // a shared bundle that refused it would report a completed freeze as a
    // failed request.
    expect(PageGovernanceProposalResponseSchema.parse({ proposal }).proposal.status).toBe('finalized');
    expect(PageGovernanceProposalResponseSchema.parse({
      proposal: { ...proposal, status: 'approved', baselineId: null, finalizeError: 'freeze_busy' },
    }).proposal.finalizeError).toBe('freeze_busy');
    expect(PageGovernanceProposalResponseSchema.safeParse({
      proposal: { ...proposal, status: 'frozen' },
    }).success).toBe(false);
  });

  it('parses the lifecycle detail of a page its approvals froze, licensed and unlicensed', () => {
    const frozen = {
      isFrozen: true,
      baselineId: ID,
      frozenVersion: 3,
      frozenAt: '2026-09-18T12:05:00.000Z',
      frozenBy: ACTOR_ID,
      frozenByName: 'Example Admin',
      freezeReason: 'Approved by every required role',
      provenance: 'authenticated_approval',
      contentRevision: '12',
      lifecycleRevision: '9',
      canFreeze: false,
      freezeDeniedReason: 'page_is_frozen',
      canUnfreeze: true,
      unfreezeDeniedReason: null,
      canApprove: false,
      approveDeniedReason: 'page_is_frozen',
      canMutateContent: false,
      mutateContentDeniedReason: 'page_is_frozen',
      governanceEnabled: true,
      governanceProposalStatus: 'finalized',
      governanceProposalId: ID,
    };
    // After the final approval the page detail names the proposal that froze
    // it; a bundle that refused `finalized` here would lose the whole detail.
    expect(PageFreezeDetailFieldsSchema.parse(frozen)).toEqual(frozen);

    // A lapsed licence is its own denial, not an unreachable workflow.
    const unlicensed = { ...frozen, approveDeniedReason: 'governance_license_required' };
    expect(PageFreezeDetailFieldsSchema.parse(unlicensed)).toEqual(unlicensed);
  });

  it('keeps signatory email out of ordinary history while retaining it in admin evidence', () => {
    const history = {
      id: ID,
      action: 'freeze',
      baselineId: ID,
      pageId: 7,
      version: 3,
      manifestDigest: DIGEST,
      contentRevision: '12',
      lifecycleRevision: '8',
      reason: 'Approved immutable record',
      actorId: ACTOR_ID,
      actorName: 'Example Admin',
      provenance: 'manual_assertion',
      reportedSignatories: [{ displayName: 'Reviewer' }],
      reportedReference: null,
      createdAt: '2026-09-18T12:00:00.000Z',
    };
    expect(PageFreezeHistoryEntrySchema.safeParse(history).success).toBe(true);
    expect(PageFreezeHistoryEntrySchema.safeParse({
      ...history,
      reportedSignatories: [{ displayName: 'Reviewer', email: 'reviewer@example.com' }],
    }).success).toBe(false);

    expect(PageBaselineEvidenceSchema.safeParse({
      baselineId: ID,
      originalPageId: 7,
      livePageId: null,
      pageIdentity: ['page', 'standalone', '7', null],
      version: 3,
      contentRevision: '12',
      manifestVersion: 1,
      manifestDigest: DIGEST,
      manifest: [],
      attachments: [],
      totalBytes: 0,
      title: 'Retained page',
      preparedBy: ACTOR_ID,
      preparedByName: 'Example Admin',
      publishedBy: null,
      publishedByName: 'Deleted Admin',
      provenance: 'manual_assertion',
      reportedSignatories: [{ displayName: 'Reviewer', email: 'reviewer@example.com' }],
      reportedReference: 'CAB-42',
      publishedAt: '2026-09-18T12:00:00.000Z',
    }).success).toBe(true);
  });
});
