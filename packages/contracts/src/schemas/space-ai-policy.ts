import { z } from 'zod';
import { AiPolicySchema } from './ai-policy.js';

/** Opaque PostgreSQL row-version token. Clients must not interpret it. */
export const SpaceAiPolicyRevisionSchema = z.string().regex(/^\d+$/);
export const UpdateSpaceAiPolicySchema = z.object({
  policy: AiPolicySchema.nullable(),
  expectedRevision: SpaceAiPolicyRevisionSchema,
}).strict();
export const SpaceAiPolicySettingsSchema = z.object({
  ok: z.literal(true),
  spaceKey: z.string(),
  defaultAiPolicy: AiPolicySchema,
  effectiveCreationDefault: AiPolicySchema,
  revision: SpaceAiPolicyRevisionSchema,
  entitled: z.boolean(),
  canManage: z.boolean(),
  enforcementAvailable: z.boolean(),
});
export type SpaceAiPolicySettings = z.infer<typeof SpaceAiPolicySettingsSchema>;
