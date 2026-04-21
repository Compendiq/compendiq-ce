import { z } from 'zod';

export const ReEmbedRequestSchema = z.object({
  model: z.string().optional(), // New embedding model (requires env var change + restart)
});

export type ReEmbedRequest = z.infer<typeof ReEmbedRequestSchema>;

export const ReferenceActionSchema = z.enum(['flag', 'strip', 'off']);
export type ReferenceAction = z.infer<typeof ReferenceActionSchema>;

// AdminSettings is now scoped to non-LLM configuration only.
// LLM provider configuration lives in the `llm_providers` table and is
// managed through `/api/admin/llm-providers` + `/api/admin/llm-usecases`.
// Embedding dimensions remain here because the shared `page_embeddings`
// vector column size is decided once per install (with admin-triggered
// reembeds when the active provider's dimension changes).
export const AdminSettingsSchema = z.object({
  embeddingDimensions: z.number().int().min(128).max(4096),
  ftsLanguage: z.string().min(1),
  embeddingChunkSize: z.number().int().min(128).max(2048),
  embeddingChunkOverlap: z.number().int().min(0).max(512),
  /**
   * URL of the draw.io embed server used in the diagram editor.
   * Null means the default (https://embed.diagrams.net) is used.
   * Useful for corporate/firewalled environments that need a self-hosted draw.io instance.
   * The backend returns an explicit `null` when unset (see GET /api/admin/settings),
   * so the read schema must accept `null` rather than `undefined`.
   */
  drawioEmbedUrl: z.string().url().nullable(),
  // AI Safety settings
  aiGuardrailNoFabrication: z.string().max(5000).optional(),
  aiGuardrailNoFabricationEnabled: z.boolean().optional(),
  aiOutputRuleStripReferences: z.boolean().optional(),
  aiOutputRuleReferenceAction: ReferenceActionSchema.optional(),
  // Rate limits (requests per minute)
  rateLimitGlobal: z.number().int().min(10).max(10000).optional(),
  rateLimitAuth: z.number().int().min(3).max(1000).optional(),
  rateLimitAdmin: z.number().int().min(5).max(1000).optional(),
  rateLimitLlmStream: z.number().int().min(1).max(1000).optional(),
  rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
  /**
   * Issue #257 — how many completed/failed re-embed-all BullMQ jobs are
   * retained in Redis before the oldest get swept. Takes effect on the
   * next re-embed run (read per-enqueue inside `enqueueReembedAll`).
   * Default 150, clamped to [10, 10000].
   */
  reembedHistoryRetention: z.number().int().min(10).max(10_000),
});

export const UpdateAdminSettingsSchema = z.object({
  ftsLanguage: z.string().min(1).optional(),
  embeddingChunkSize: z.number().int().min(128).max(2048).optional(),
  embeddingChunkOverlap: z.number().int().min(0).max(512).optional(),
  /**
   * Update semantics:
   *  - field omitted → leave existing value unchanged
   *  - null          → clear stored value (backend deletes the row, falls back to default)
   *  - URL string    → set / replace value
   */
  drawioEmbedUrl: z.string().url().nullish(),
  // AI Safety settings
  aiGuardrailNoFabrication: z.string().max(5000).optional(),
  aiGuardrailNoFabricationEnabled: z.boolean().optional(),
  aiOutputRuleStripReferences: z.boolean().optional(),
  aiOutputRuleReferenceAction: ReferenceActionSchema.optional(),
  // Rate limits (requests per minute)
  rateLimitGlobal: z.number().int().min(10).max(10000).optional(),
  rateLimitAuth: z.number().int().min(3).max(1000).optional(),
  rateLimitAdmin: z.number().int().min(5).max(1000).optional(),
  rateLimitLlmStream: z.number().int().min(1).max(1000).optional(),
  rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
  /** Issue #257 — optional on update; omitted → leave unchanged. */
  reembedHistoryRetention: z.number().int().min(10).max(10_000).optional(),
});

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsSchema>;
