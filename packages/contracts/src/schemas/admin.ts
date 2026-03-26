import { z } from 'zod';
import { LlmProviderSchema } from './settings.js';

export const ReEmbedRequestSchema = z.object({
  model: z.string().optional(), // New embedding model (requires env var change + restart)
});

export type ReEmbedRequest = z.infer<typeof ReEmbedRequestSchema>;

export const ReferenceActionSchema = z.enum(['flag', 'strip', 'off']);
export type ReferenceAction = z.infer<typeof ReferenceActionSchema>;

export const AdminSettingsSchema = z.object({
  llmProvider: LlmProviderSchema,
  ollamaModel: z.string(),
  openaiBaseUrl: z.string().nullable(),
  hasOpenaiApiKey: z.boolean(),
  openaiModel: z.string().nullable(),
  embeddingModel: z.string(),
  embeddingChunkSize: z.number().int().min(128).max(2048),
  embeddingChunkOverlap: z.number().int().min(0).max(512),
  /**
   * URL of the draw.io embed server used in the diagram editor.
   * Null/undefined means the default (https://embed.diagrams.net) is used.
   * Useful for corporate/firewalled environments that need a self-hosted draw.io instance.
   */
  drawioEmbedUrl: z.string().url().optional(),
  // AI Safety settings
  aiGuardrailNoFabrication: z.string().optional(),
  aiGuardrailNoFabricationEnabled: z.boolean().optional(),
  aiOutputRuleStripReferences: z.boolean().optional(),
  aiOutputRuleReferenceAction: ReferenceActionSchema.optional(),
  // Rate limits (requests per minute)
  rateLimitGlobal: z.number().int().min(10).max(10000).optional(),
  rateLimitAuth: z.number().int().min(3).max(1000).optional(),
  rateLimitAdmin: z.number().int().min(5).max(1000).optional(),
  rateLimitLlmStream: z.number().int().min(1).max(1000).optional(),
  rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
  rateLimitOidc: z.number().int().min(3).max(1000).optional(),
});

export const UpdateAdminSettingsSchema = z.object({
  llmProvider: LlmProviderSchema.optional(),
  ollamaModel: z.string().optional(),
  openaiBaseUrl: z.string().url().nullable().optional(),
  openaiApiKey: z.string().min(1).optional(),
  openaiModel: z.string().nullable().optional(),
  embeddingModel: z.string().min(1).optional(),
  embeddingChunkSize: z.number().int().min(128).max(2048).optional(),
  embeddingChunkOverlap: z.number().int().min(0).max(512).optional(),
  drawioEmbedUrl: z.string().url().optional(),
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
  rateLimitOidc: z.number().int().min(3).max(1000).optional(),
});

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsSchema>;
