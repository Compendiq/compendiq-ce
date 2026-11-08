import { z } from 'zod';
import { AiPolicySchema } from './ai-policy.js';

export const AiPolicyCascadePreviewSchema = z.object({
  ok: z.literal(true), rootId: z.number().int().positive(), policy: AiPolicySchema,
  scope: z.literal('owned_standalone'), limitation: z.string(),
  items: z.array(z.object({ pageId: z.number().int().positive(), policy: AiPolicySchema, revision: z.number().int().nonnegative() })),
});
export type AiPolicyCascadePreview = z.infer<typeof AiPolicyCascadePreviewSchema>;
