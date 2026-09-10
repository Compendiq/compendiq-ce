import { z } from 'zod';
import { PageSourceEnum } from './pages.js';

/** Subprotocol the gateway negotiates. Never echo a JWT as the chosen protocol. */
export const COLLAB_WS_PROTOCOL = 'compendiq.collab.v1' as const;

export const CollabConfigSchema = z.object({
  enabled: z.boolean(),
});

export type CollabConfig = z.infer<typeof CollabConfigSchema>;

/** Body for POST /api/pages/:id/collab/commit. Server snapshots the Y.Doc. */
export const CollabCommitSchema = z.object({
  title: z.string().min(1).max(500),
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
