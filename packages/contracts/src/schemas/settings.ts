import { z } from 'zod';

export const LlmProviderSchema = z.enum(['ollama', 'openai']);
export type LlmProviderType = z.infer<typeof LlmProviderSchema>;

export const UserSettingsSchema = z.object({
  confluenceUrl: z.string().url().nullable(),
  confluencePat: z.string().nullable(), // Only sent on update, never returned
  selectedSpaces: z.array(z.string()),
  ollamaModel: z.string(),
  llmProvider: LlmProviderSchema,
  openaiBaseUrl: z.string().nullable(),
  openaiApiKey: z.string().nullable(), // Only sent on update, never returned
  openaiModel: z.string().nullable(),
  theme: z.string(),
  syncIntervalMin: z.number().int().min(1).max(1440),
  showSpaceHomeContent: z.boolean(),
});

export const UpdateSettingsSchema = UserSettingsSchema.partial();

export const SettingsResponseSchema = z.object({
  confluenceUrl: z.string().url().nullable(),
  hasConfluencePat: z.boolean(), // Never expose the actual PAT
  selectedSpaces: z.array(z.string()),
  ollamaModel: z.string(),
  llmProvider: LlmProviderSchema,
  openaiBaseUrl: z.string().nullable(),
  hasOpenaiApiKey: z.boolean(), // Never expose the actual key
  openaiModel: z.string().nullable(),
  embeddingModel: z.string(), // Read-only, server-wide
  theme: z.string(),
  syncIntervalMin: z.number(),
  confluenceConnected: z.boolean(),
  showSpaceHomeContent: z.boolean(),
});

export const TestConfluenceSchema = z.object({
  url: z.string().url(),
  pat: z.string().min(1),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type TestConfluenceInput = z.infer<typeof TestConfluenceSchema>;
