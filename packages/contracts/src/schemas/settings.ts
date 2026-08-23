import { z } from 'zod';

/** Valid keys for custom system prompt overrides. */
export const CUSTOM_PROMPT_KEYS = [
  'improve_grammar',
  'improve_structure',
  'improve_clarity',
  'improve_technical',
  'improve_completeness',
  'generate',
  'generate_spec',
  'generate_guide',
  'generate_notes',
  'generate_postmortem',
  'generate_architecture',
  'generate_runbook',
  'generate_howto',
  'generate_troubleshooting',
] as const;
export type CustomPromptKey = (typeof CUSTOM_PROMPT_KEYS)[number];

export const CustomPromptsSchema = z.object(
  Object.fromEntries(CUSTOM_PROMPT_KEYS.map((k) => [k, z.string().max(5000).optional()])) as {
    [K in CustomPromptKey]: z.ZodOptional<z.ZodString>;
  },
).strict().default({});
export type CustomPrompts = Partial<Record<CustomPromptKey, string>>;

export const InlineCompletionDelaySchema = z.enum([
  'fast',
  'balanced',
  'deliberate',
  'manual',
]);
export type InlineCompletionDelay = z.infer<typeof InlineCompletionDelaySchema>;

// #1402 (phase 1/3): per-user onboarding checklist state. Deliberately
// narrower than the issue's literal draft — `patConfigured` and
// `spacesSelected` are NOT persisted here because both are safely derivable
// client-side from `hasConfluencePat` / `selectedSpaces.length > 0` (already
// on SettingsResponseSchema below). A stored boolean for either would drift
// from the truth the moment a user disconnects their PAT (precedent: merged
// PR #1142, "remove derived, fabricated and unreadable UI from the app
// surfaces").
export const OnboardingStateSchema = z.object({
  firstAiQueryMade: z.boolean().default(false),
  shortcutsModalViewed: z.boolean().default(false),
  pageCreatedOrEdited: z.boolean().default(false),
  dismissed: z.boolean().default(false),
  completedAt: z.string().datetime().nullable().default(null),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

// #1402: the write-side counterpart, deliberately NOT `OnboardingStateSchema.partial()`.
// In zod v4, `.partial()` only wraps each field in `.optional()` — it does not
// strip a field's own `.default()` — so a missing key still resolves through
// that default and reappears in the parsed object (verified: parsing `{ a:
// true }` through `z.object({ a: z.boolean().default(false), b:
// z.boolean().default(false) }).partial()` yields `{ a: true, b: false }`, not
// `{ a: true }`). Stringifying that into `PUT /settings`'s JSONB merge would
// write every OTHER flag back to its default on every single-key patch —
// exactly the overwrite bug the merge operator exists to prevent. Plain
// `.optional()` with no field-level default is the schema that actually drops
// unset keys, so JSON.stringify omits them and the JSONB `||` merge leaves
// sibling keys untouched.
export const OnboardingStatePatchSchema = z.object({
  firstAiQueryMade: z.boolean().optional(),
  shortcutsModalViewed: z.boolean().optional(),
  pageCreatedOrEdited: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  completedAt: z.string().datetime().nullable().optional(),
}).strict();
export type OnboardingStatePatch = z.infer<typeof OnboardingStatePatchSchema>;

export const UserSettingsSchema = z.object({
  confluenceUrl: z.string().url().nullable(),
  confluencePat: z.string().nullable(), // Only sent on update, never returned
  selectedSpaces: z.array(z.string()),
  theme: z.string(),
  syncIntervalMin: z.number().int().min(1).max(1440),
  showSpaceHomeContent: z.boolean(),
  customPrompts: CustomPromptsSchema.optional(),
  inlineCompletionEnabled: z.boolean(),
  inlineCompletionDelay: InlineCompletionDelaySchema,
  inlineCompletionCodeOnly: z.boolean(),
  onboardingState: OnboardingStateSchema,
});

export const UpdateSettingsSchema = z.object({
  confluenceUrl: z.string().url().nullable().optional(),
  confluencePat: z.string().nullable().optional(),
  selectedSpaces: z.array(z.string()).optional(),
  theme: z.string().optional(),
  syncIntervalMin: z.number().int().min(1).max(1440).optional(),
  showSpaceHomeContent: z.boolean().optional(),
  customPrompts: CustomPromptsSchema.optional(),
  inlineCompletionEnabled: z.boolean().optional(),
  inlineCompletionDelay: InlineCompletionDelaySchema.optional(),
  inlineCompletionCodeOnly: z.boolean().optional(),
  // #771: true → record dismissal of the Confluence-PAT onboarding banner
  // (server stores NOW() in user_settings.confluence_pat_prompt_dismissed_at);
  // false → clear the dismissal so the banner can reappear.
  confluencePatPromptDismissed: z.boolean().optional(),
  // #1402: partial-patch semantics — a caller sends the one key it wants to
  // flip (e.g. { firstAiQueryMade: true }), never the whole object. The route
  // merges this at the top level (Postgres JSONB `||`), never overwrites.
  // OnboardingStatePatchSchema, not OnboardingStateSchema.partial() — see the
  // comment on OnboardingStatePatchSchema above for why the latter reintroduces
  // the overwrite bug this field exists to avoid.
  onboardingState: OnboardingStatePatchSchema.optional(),
});

export const SettingsResponseSchema = z.object({
  confluenceUrl: z.string().url().nullable(),
  hasConfluencePat: z.boolean(), // Never expose the actual PAT
  selectedSpaces: z.array(z.string()),
  theme: z.string(),
  syncIntervalMin: z.number(),
  confluenceConnected: z.boolean(),
  showSpaceHomeContent: z.boolean(),
  customPrompts: CustomPromptsSchema,
  inlineCompletionEnabled: z.boolean(),
  inlineCompletionDelay: InlineCompletionDelaySchema,
  inlineCompletionCodeOnly: z.boolean(),
  // #771: whether the user dismissed the Confluence-PAT onboarding banner.
  // Derived server-side from confluence_pat_prompt_dismissed_at IS NOT NULL —
  // the timestamp itself is never exposed.
  confluencePatPromptDismissed: z.boolean(),
  // #1402: always fully defaulted, including for a row that predates this
  // migration or predates a given flag — the route parses the stored `{}` (or
  // partial object) through OnboardingStateSchema on every read.
  onboardingState: OnboardingStateSchema,
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
