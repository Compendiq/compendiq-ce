import { z } from 'zod';
import {
  LlmProviderTypeSchema,
  UsecaseAssignmentsSchema,
  UpdateUsecaseAssignmentsInputSchema,
} from '../llm.js';

export const ReEmbedRequestSchema = z.object({
  model: z.string().optional(), // New embedding model (requires env var change + restart)
});

export type ReEmbedRequest = z.infer<typeof ReEmbedRequestSchema>;

export const ReferenceActionSchema = z.enum(['flag', 'strip', 'off']);
export type ReferenceAction = z.infer<typeof ReferenceActionSchema>;

export const AdminSettingsSchema = z.object({
  llmProvider: LlmProviderTypeSchema,
  ollamaModel: z.string().min(1),
  openaiBaseUrl: z.string().url().nullable(),
  hasOpenaiApiKey: z.boolean(),
  openaiModel: z.string().min(1).nullable(),
  embeddingModel: z.string().min(1),
  // Derived from the active embedding model; read-only in GET /admin/settings
  // and intentionally not accepted by UpdateAdminSettingsSchema.
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
  // Per-use-case LLM provider/model overrides (issue #214)
  usecaseAssignments: UsecaseAssignmentsSchema,
});

export const UpdateAdminSettingsSchema = z.object({
  llmProvider: LlmProviderTypeSchema.optional(),
  ollamaModel: z.string().optional(),
  /**
   * Update semantics:
   *  - field omitted → leave existing value unchanged
   *  - null          → clear stored value (backend deletes the row, falls back to default)
   *  - URL string    → set / replace value
   */
  openaiBaseUrl: z.string().url().nullish(),
  openaiApiKey: z.string().min(1).optional(),
  /**
   * Update semantics: same omit/null/value tri-state as openaiBaseUrl above.
   */
  openaiModel: z.string().nullish(),
  embeddingModel: z.string().min(1).optional(),
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
  // Per-use-case LLM provider/model overrides (issue #214)
  usecaseAssignments: UpdateUsecaseAssignmentsInputSchema.optional(),
});

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsSchema>;
