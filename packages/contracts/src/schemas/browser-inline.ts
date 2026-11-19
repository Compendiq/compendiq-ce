import { z } from 'zod';

/** Fresh authorization for the supported browser inline path, not attestation. */
export const BrowserInlineAuthorizationRequestSchema = z.object({
  pageId: z.number().int().positive().safe(),
});
export const BrowserInlineAuthorizationResponseSchema = z.object({
  pageId: z.number().int().positive().safe(),
  authorized: z.literal(true),
  aiPolicy: z.enum(['all', 'local_only']),
  aiPolicyRevision: z.number().int().nonnegative().safe(),
});
