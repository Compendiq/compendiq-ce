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
