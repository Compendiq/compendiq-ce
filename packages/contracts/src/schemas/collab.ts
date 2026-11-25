import { z } from 'zod';
import { PageSourceEnum } from './pages.js';
import { PageRevisionSchema } from './page-baselines.js';

/** Subprotocol the gateway negotiates. Never echo a JWT as the chosen protocol. */
export const COLLAB_WS_PROTOCOL = 'compendiq.collab.v1' as const;

export const CollabConfigSchema = z.object({
  enabled: z.boolean(),
});

export type CollabConfig = z.infer<typeof CollabConfigSchema>;

/**
 * Reasons the gateway sends with WebSocket close 4403
 * (docs/architecture/12-realtime-collaboration.md). Clients treat any other
 * reason as `forbidden`.
 */
export const CollabRefusalReasonSchema = z.enum(['forbidden', 'readonly', 'rate_limited', 'flag_off']);
export type CollabRefusalReason = z.infer<typeof CollabRefusalReasonSchema>;

/**
 * Fixed window of the per-user upgrade limiter (`collab:upgrade:<userId>`).
 * A `rate_limited` join may retry once a full window has passed since the
 * refusal.
 */
export const COLLAB_UPGRADE_WINDOW_SEC = 60;

/**
 * Positive WebSocket write-admission acknowledgement. Page lifecycle state
 * alone never implies edit authority: read-only viewers receive the same
 * lifecycle revision.
 */
export const CollabWritableAdmissionControlSchema = z.object({
  type: z.literal('writable_admission'),
  lifecycleRevision: z.string().regex(/^\d+$/),
}).strict();
export type CollabWritableAdmissionControl = z.infer<
  typeof CollabWritableAdmissionControlSchema
>;

/**
 * Identity of a collaborative document lineage (#2034): the server-owned
 * `page_collaborative_docs.doc_epoch`. It is not a credential; a client only
 * echoes it as the `expectedDocEpoch` join parameter.
 */
export const CollabDocEpochSchema = z.string().uuid();
export type CollabDocEpoch = z.infer<typeof CollabDocEpochSchema>;

/**
 * Value of the `expectedDocEmpty` join parameter (#2034). The parameter is a
 * flag: set, it says "my `Y.Doc` holds nothing". `1` is its only value.
 */
export const COLLAB_DOC_EMPTY_MARKER = '1' as const;
export const CollabDocEmptyMarkerSchema = z.literal(COLLAB_DOC_EMPTY_MARKER);

/**
 * What a join to `/api/collab/:pageId` declares about the document its client
 * holds (#2034), as query parameters: the epoch that document was synced
 * from, or that it holds no document, or nothing. The two parameters exclude
 * each other; anything this schema rejects is a malformed declaration, never
 * an absent one. Neither parameter is a credential, and the server cannot
 * check the empty-document claim.
 */
export const CollabJoinDeclarationSchema = z.union([
  z.object({ expectedDocEpoch: CollabDocEpochSchema, expectedDocEmpty: z.undefined().optional() }),
  z.object({ expectedDocEpoch: z.undefined().optional(), expectedDocEmpty: CollabDocEmptyMarkerSchema }),
  z.object({ expectedDocEpoch: z.undefined().optional(), expectedDocEmpty: z.undefined().optional() }),
]);
export type CollabJoinDeclaration = z.infer<typeof CollabJoinDeclarationSchema>;

/** Server control frame naming the lineage of the document a socket is attached to. */
export const CollabDocEpochControlSchema = z.object({
  type: z.literal('doc_epoch'),
  epoch: CollabDocEpochSchema,
}).strict();
export type CollabDocEpochControl = z.infer<typeof CollabDocEpochControlSchema>;

/** Body for POST /api/pages/:id/collab/commit. Server snapshots the Y.Doc. */
export const CollabCommitSchema = z.object({
  title: z.string().min(1).max(500),
  expectedLifecycleRevision: PageRevisionSchema,
  /** Yjs clocks AND deletions captured when Save starts; never document content. */
  expectedDocumentState: z.string().base64().min(4).max(1_048_576),
});
export type CollabCommit = z.infer<typeof CollabCommitSchema>;

export const CollabCommitResponseSchema = z.object({
  id: z.number(),
  title: z.string(),
  version: z.number(),
  source: PageSourceEnum,
  pushedToConfluence: z.boolean().optional(),
});
export type CollabCommitResponse = z.infer<typeof CollabCommitResponseSchema>;
