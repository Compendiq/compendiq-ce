import { z } from 'zod';

export const LlmProviderSchema = z.enum(['ollama', 'openai']);
export type LlmProviderType = z.infer<typeof LlmProviderSchema>;

/** Valid keys for custom system prompt overrides. */
export const CUSTOM_PROMPT_KEYS = [
  'improve_grammar',
  'improve_structure',
  'improve_clarity',
  'improve_technical',
  'improve_completeness',
] as const;
export type CustomPromptKey = (typeof CUSTOM_PROMPT_KEYS)[number];

export const CustomPromptsSchema = z.object(
  Object.fromEntries(CUSTOM_PROMPT_KEYS.map((k) => [k, z.string().max(5000).optional()])) as {
    [K in CustomPromptKey]: z.ZodOptional<z.ZodString>;
  },
).strict().default({});
export type CustomPrompts = Partial<Record<CustomPromptKey, string>>;

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
  customPrompts: CustomPromptsSchema.optional(),
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
  customPrompts: CustomPromptsSchema,
});

export const SyncProgressSchema = z.object({
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  space: z.string().optional(),
});

export const UserSyncStatusSchema = z.object({
  userId: z.string(),
  status: z.enum(['idle', 'syncing', 'embedding', 'error']),
  progress: SyncProgressSchema.optional(),
  lastSynced: z.string().datetime().optional(),
  error: z.string().optional(),
});

export const AssetSyncCountsSchema = z.object({
  expected: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});

export const SyncOverviewSpaceSchema = z.object({
  spaceKey: z.string(),
  spaceName: z.string(),
  status: z.enum(['not_synced', 'syncing', 'healthy', 'degraded']),
  lastSynced: z.string().datetime().nullable(),
  pageCount: z.number().int().nonnegative(),
  pagesWithAssets: z.number().int().nonnegative(),
  pagesWithIssues: z.number().int().nonnegative(),
  images: AssetSyncCountsSchema,
  drawio: AssetSyncCountsSchema,
});

export const SyncOverviewIssueSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string(),
  spaceKey: z.string(),
  missingImages: z.number().int().nonnegative(),
  missingDrawio: z.number().int().nonnegative(),
  missingFiles: z.array(z.string()),
});

export const SyncOverviewResponseSchema = z.object({
  sync: UserSyncStatusSchema,
  totals: z.object({
    selectedSpaces: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    pagesWithAssets: z.number().int().nonnegative(),
    pagesWithIssues: z.number().int().nonnegative(),
    healthyPages: z.number().int().nonnegative(),
    images: AssetSyncCountsSchema,
    drawio: AssetSyncCountsSchema,
  }),
  spaces: z.array(SyncOverviewSpaceSchema),
  issues: z.array(SyncOverviewIssueSchema),
});

export const TestConfluenceSchema = z.object({
  url: z.string().url(),
  // Optional: if omitted the backend uses the stored encrypted PAT
  pat: z.string().min(1).optional(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type TestConfluenceInput = z.infer<typeof TestConfluenceSchema>;
export type UserSyncStatus = z.infer<typeof UserSyncStatusSchema>;
export type AssetSyncCounts = z.infer<typeof AssetSyncCountsSchema>;
export type SyncOverviewSpace = z.infer<typeof SyncOverviewSpaceSchema>;
export type SyncOverviewIssue = z.infer<typeof SyncOverviewIssueSchema>;
export type SyncOverviewResponse = z.infer<typeof SyncOverviewResponseSchema>;
