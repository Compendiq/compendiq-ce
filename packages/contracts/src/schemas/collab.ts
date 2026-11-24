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

/** Server control frame naming the lineage of the document a socket is attached to. */
export const CollabDocEpochControlSchema = z.object({
  type: z.literal('doc_epoch'),
  epoch: CollabDocEpochSchema,
}).strict();
export type CollabDocEpochControl = z.infer<typeof CollabDocEpochControlSchema>;

/**
 * Server control frame (#2035): a collaborative save of this page did not
 * finish and its result is unknown, so the room accepts no further edits until
 * that save is resolved. It carries no payload and only removes edit authority.
 */
export const CollabCommitUnknownControlSchema = z.object({
  type: z.literal('commit_unknown'),
}).strict();
export type CollabCommitUnknownControl = z.infer<typeof CollabCommitUnknownControlSchema>;

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

/**
 * What a collaborative Save that answered 409 `confluence_modified` had done
 * to Confluence when it found the newer version (#2035).
 * `not_dispatched`: the version check ran before anything was sent, so the
 * page was not saved and the editing session stays open. `unknown`: Confluence
 * refused the write itself after it was sent; the save's result is unknown and
 * the room stops accepting edits until it is resolved. A server that predates
 * the field sends none.
 */
export const CollabCommitConflictSaveOutcomeSchema = z.enum(['not_dispatched', 'unknown']);
export type CollabCommitConflictSaveOutcome = z.infer<typeof CollabCommitConflictSaveOutcomeSchema>;

/** The typed part of the 409 body of POST /api/pages/:id/collab/commit. */
export const CollabCommitConflictSchema = z.object({
  code: z.literal('confluence_modified'),
  remoteVersion: z.number().int().optional(),
  localVersion: z.number().int().optional(),
  saveOutcome: CollabCommitConflictSaveOutcomeSchema.optional(),
});
export type CollabCommitConflict = z.infer<typeof CollabCommitConflictSchema>;
