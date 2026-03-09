import { z } from 'zod';

export const UserSettingsSchema = z.object({
  confluenceUrl: z.string().url().nullable(),
  confluencePat: z.string().nullable(), // Only sent on update, never returned
  selectedSpaces: z.array(z.string()),
  ollamaModel: z.string(),
  theme: z.string(),
  syncIntervalMin: z.number().int().min(1).max(1440),
  llmProvider: z.enum(['ollama', 'openai']).default('ollama'),
  openaiBaseUrl: z.string().url().nullable().optional(),
  openaiApiKey: z.string().nullable().optional(),   // Only sent on update, never returned
  openaiModel: z.string().optional(),
});

export const UpdateSettingsSchema = UserSettingsSchema.partial();

export const SettingsResponseSchema = z.object({
  confluenceUrl: z.string().url().nullable(),
  hasConfluencePat: z.boolean(), // Never expose the actual PAT
  selectedSpaces: z.array(z.string()),
  ollamaModel: z.string(),
  embeddingModel: z.string(), // Read-only, server-wide
  theme: z.string(),
  syncIntervalMin: z.number(),
  confluenceConnected: z.boolean(),
  llmProvider: z.enum(['ollama', 'openai']),
  openaiBaseUrl: z.string().url().nullable(),
  hasOpenaiApiKey: z.boolean(),    // Never expose the actual key
  openaiModel: z.string(),
});

export const TestConfluenceSchema = z.object({
  url: z.string().url(),
  pat: z.string().min(1),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type TestConfluenceInput = z.infer<typeof TestConfluenceSchema>;
