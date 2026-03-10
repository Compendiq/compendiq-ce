import { z } from 'zod';

export const ReEmbedRequestSchema = z.object({
  model: z.string().optional(), // New embedding model (requires env var change + restart)
});

export type ReEmbedRequest = z.infer<typeof ReEmbedRequestSchema>;

export const AdminSettingsSchema = z.object({
  embeddingChunkSize: z.number().int().min(128).max(2048),
  embeddingChunkOverlap: z.number().int().min(0).max(512),
});

export const UpdateAdminSettingsSchema = AdminSettingsSchema.partial();

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsSchema>;
