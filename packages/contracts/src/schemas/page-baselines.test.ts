import { describe, expect, it } from 'vitest';
import {
  FreezePageRequestSchema,
  PageBaselineEvidenceSchema,
  PageFreezeHistoryEntrySchema,
  PageFreezePreviewResponseSchema,
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
