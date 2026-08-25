import { z } from 'zod';

/** Subprotocol the gateway negotiates. Never echo a JWT as the chosen protocol. */
export const COLLAB_WS_PROTOCOL = 'compendiq.collab.v1' as const;

export const CollabConfigSchema = z.object({
  enabled: z.boolean(),
});

export type CollabConfig = z.infer<typeof CollabConfigSchema>;
