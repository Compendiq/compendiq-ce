import { z } from 'zod';

export const PageRevisionSchema = z.string().regex(/^(?:0|[1-9]\d*)$/, 'Expected a non-negative decimal revision');
export type PageRevision = z.infer<typeof PageRevisionSchema>;

export const ManifestDigestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest');
export const BaselineProvenanceSchema = z.enum(['manual_assertion', 'authenticated_approval']);
export type BaselineProvenance = z.infer<typeof BaselineProvenanceSchema>;

export const PageFreezeSummaryFieldsSchema = z.object({
  isFrozen: z.boolean(),
  baselineId: z.string().uuid().nullable(),
  frozenVersion: z.number().int().safe().positive().nullable(),
}).strict();
export type PageFreezeSummary = z.infer<typeof PageFreezeSummaryFieldsSchema>;

export const PageLifecycleDenialReasonSchema = z.enum([
  'baseline_creation_disabled',
  'deployment_not_ready',
  'page_not_found',
  'page_deleted',
  'page_is_frozen',
  'page_not_frozen',
  'not_authorized',
  'freeze_busy',
  'governance_required',
  'governance_unavailable',
  'approval_required',
  'stale_manifest',
  'stale_lifecycle',
]);
export type PageLifecycleDenialReason = z.infer<typeof PageLifecycleDenialReasonSchema>;

export const PageGovernanceProposalStatusSchema = z.enum([
  'none',
  'draft',
  'in_review',
  'approved',
  'rejected',
  'withdrawn',
  'unavailable',
]);
export type PageGovernanceProposalStatus = z.infer<typeof PageGovernanceProposalStatusSchema>;

export const PendingPageDivergenceSchema = z.object({
  count: z.number().int().nonnegative(),
  latestAt: z.string().datetime().nullable(),
}).strict();
export type PendingPageDivergence = z.infer<typeof PendingPageDivergenceSchema>;

export const PageFreezeDetailFieldsSchema = PageFreezeSummaryFieldsSchema.extend({
  frozenAt: z.string().datetime().nullable(),
  frozenBy: z.string().uuid().nullable(),
  frozenByName: z.string().nullable(),
  freezeReason: z.string().nullable(),
  provenance: BaselineProvenanceSchema.nullable(),
  contentRevision: PageRevisionSchema,
  lifecycleRevision: PageRevisionSchema,
  canFreeze: z.boolean(),
  freezeDeniedReason: PageLifecycleDenialReasonSchema.nullable(),
  canUnfreeze: z.boolean(),
  unfreezeDeniedReason: PageLifecycleDenialReasonSchema.nullable(),
  canApprove: z.boolean(),
  approveDeniedReason: PageLifecycleDenialReasonSchema.nullable(),
  canMutateContent: z.boolean(),
  mutateContentDeniedReason: PageLifecycleDenialReasonSchema.nullable(),
  governanceProposalStatus: PageGovernanceProposalStatusSchema.nullable(),
  pendingDivergence: PendingPageDivergenceSchema.nullable(),
}).strict();
export type PageLifecycleState = z.infer<typeof PageFreezeDetailFieldsSchema>;

export const BaselineAttachmentSchema = z.object({
  identity: ManifestDigestSchema,
  store: z.enum(['local', 'confluence', 'icon']),
  pageKey: z.string().min(1).max(512),
  filename: z.string().min(1).max(255),
  size: z.number().int().nonnegative().safe(),
  mediaType: z.string().min(1).max(255),
  sha256: ManifestDigestSchema,
}).strict();
export type BaselineAttachmentWire = z.infer<typeof BaselineAttachmentSchema>;

export const PageFreezePreviewResponseSchema = z.object({
  baselineId: z.string().uuid(),
  pageId: z.number().int().positive(),
  version: z.number().int().safe().positive(),
  contentRevision: PageRevisionSchema,
  manifestVersion: z.literal(1),
  manifestDigest: ManifestDigestSchema,
  attachments: z.array(BaselineAttachmentSchema),
  totalBytes: z.number().int().nonnegative().safe(),
}).strict();
export type PageFreezePreviewResponse = z.infer<typeof PageFreezePreviewResponseSchema>;

export const ReportedBaselineSignatorySchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
}).strict();
export type ReportedBaselineSignatory = z.infer<typeof ReportedBaselineSignatorySchema>;

export const FreezePageRequestSchema = z.object({
  reason: z.string().trim().min(5).max(1000),
  expectedContentRevision: PageRevisionSchema,
  expectedManifestDigest: ManifestDigestSchema,
  reportedSignatories: z.array(ReportedBaselineSignatorySchema).max(20).optional(),
  reportedReference: z.string().trim().min(1).max(500).optional(),
}).strict();
export type FreezePageRequest = z.infer<typeof FreezePageRequestSchema>;

export const UnfreezePageRequestSchema = z.object({
  reason: z.string().trim().min(10).max(1000),
  expectedBaselineId: z.string().uuid(),
  expectedLifecycleRevision: PageRevisionSchema,
}).strict();
export type UnfreezePageRequest = z.infer<typeof UnfreezePageRequestSchema>;

export const PageLifecycleMutationResponseSchema = z.object({
  state: PageFreezeDetailFieldsSchema,
}).strict();
export type PageLifecycleMutationResponse = z.infer<typeof PageLifecycleMutationResponseSchema>;

export const PageFreezeHistoryQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type PageFreezeHistoryQuery = z.infer<typeof PageFreezeHistoryQuerySchema>;

export const RedactedReportedBaselineSignatorySchema = z.object({
  displayName: z.string(),
}).strict();

export const PageFreezeHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['freeze', 'thaw']),
  baselineId: z.string().uuid(),
  pageId: z.number().int().positive(),
  version: z.number().int().safe().positive(),
  manifestDigest: ManifestDigestSchema,
  contentRevision: PageRevisionSchema,
  lifecycleRevision: PageRevisionSchema,
  reason: z.string(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string(),
  provenance: BaselineProvenanceSchema,
  reportedSignatories: z.array(RedactedReportedBaselineSignatorySchema),
  reportedReference: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type PageFreezeHistoryEntry = z.infer<typeof PageFreezeHistoryEntrySchema>;

export const PageFreezeHistoryResponseSchema = z.object({
  entries: z.array(PageFreezeHistoryEntrySchema),
  nextCursor: z.string().nullable(),
}).strict();
export type PageFreezeHistoryResponse = z.infer<typeof PageFreezeHistoryResponseSchema>;

export const PageLifecycleEventSchema = z.object({
  type: z.literal('page_lifecycle'),
  pageId: z.number().int().positive(),
  lifecycleRevision: PageRevisionSchema,
  isFrozen: z.boolean(),
  baselineId: z.string().uuid().nullable(),
}).strict();
export type PageLifecycleEvent = z.infer<typeof PageLifecycleEventSchema>;

export const PageBaselineErrorResponseSchema = z.object({
  error: z.string(),
  reason: z.string(),
  state: PageFreezeDetailFieldsSchema.optional(),
}).strict();
export type PageBaselineErrorResponse = z.infer<typeof PageBaselineErrorResponseSchema>;

export const BaselinePageIdentitySchema = z.tuple([
  z.literal('page'),
  z.enum(['standalone', 'confluence']),
  z.string().regex(/^[1-9]\d*$/),
  z.string().nullable(),
]);
export const BaselineParentIdentitySchema = z.tuple([
  z.literal('parent'),
  z.enum(['standalone', 'confluence']),
  z.string().regex(/^[1-9]\d*$/),
  z.string().nullable(),
  z.string(),
]);

export const PageBaselineEvidenceSchema = z.object({
  baselineId: z.string().uuid(),
  originalPageId: z.number().int().positive(),
  livePageId: z.number().int().positive().nullable(),
  pageIdentity: BaselinePageIdentitySchema,
  version: z.number().int().safe().positive(),
  contentRevision: PageRevisionSchema,
  manifestVersion: z.literal(1),
  manifestDigest: ManifestDigestSchema,
  manifest: z.array(z.unknown()),
  attachments: z.array(BaselineAttachmentSchema),
  totalBytes: z.number().int().nonnegative().safe(),
  title: z.string(),
  preparedBy: z.string().uuid().nullable(),
  preparedByName: z.string(),
  publishedBy: z.string().uuid().nullable(),
  publishedByName: z.string().nullable(),
  provenance: BaselineProvenanceSchema,
  reportedSignatories: z.array(ReportedBaselineSignatorySchema),
  reportedReference: z.string().nullable(),
  publishedAt: z.string().datetime(),
}).strict();
export type PageBaselineEvidence = z.infer<typeof PageBaselineEvidenceSchema>;

export const PageBaselineActivationRequestSchema = z.object({
  creationEnabled: z.boolean(),
}).strict();
export type PageBaselineActivationRequest = z.infer<typeof PageBaselineActivationRequestSchema>;

export const PageBaselineActivationStateSchema = z.object({
  creationEnabled: z.boolean(),
  deploymentReady: z.boolean(),
  blockers: z.array(z.string()),
  activatedAt: z.string().datetime().nullable(),
  activatedBy: z.string().uuid().nullable(),
  activatedByName: z.string().nullable(),
}).strict();
export type PageBaselineActivationState = z.infer<typeof PageBaselineActivationStateSchema>;
