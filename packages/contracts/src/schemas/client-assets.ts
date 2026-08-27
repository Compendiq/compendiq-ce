import { z } from 'zod';

/**
 * #1418 SPEC-016 — one generative checkpoint in VRAM.
 * Hunspell dictionaries are a different asset class (SPEC-032).
 * Hub installs land as `org--name` local ids; the original volume layout
 * `qwen2.5-0.5b-instruct-q4` remains valid.
 */
export const LEGACY_CLIENT_MODEL_ID = 'qwen2.5-0.5b-instruct-q4' as const;

export const HUNSPELL_ASSET_IDS = ['hunspell-en_US', 'hunspell-de_DE'] as const;
export const HunspellAssetIdSchema = z.enum(HUNSPELL_ASSET_IDS);
export type HunspellAssetId = z.infer<typeof HunspellAssetIdSchema>;

const RESERVED_ASSET_NAMES: Record<string, true> = {
  local: true,
  'page-icons': true,
  'client-models': true,
};

const HF_SEGMENT = '[A-Za-z0-9._-]+';
const HF_REPO_RE = new RegExp(`^${HF_SEGMENT}/${HF_SEGMENT}$`);
const HUB_LOCAL_ID_RE = new RegExp(`^${HF_SEGMENT}--${HF_SEGMENT}$`);

export const HfRepoIdSchema = z.string().regex(HF_REPO_RE).refine(
  (repo) => !RESERVED_ASSET_NAMES[repo.split('/')[0] ?? ''],
  { message: 'reserved attachment-root name' },
);
export type HfRepoId = z.infer<typeof HfRepoIdSchema>;

export const HubLocalAssetIdSchema = z.string().regex(HUB_LOCAL_ID_RE).refine(
  (id) => !RESERVED_ASSET_NAMES[id.split('--')[0] ?? ''],
  { message: 'reserved attachment-root name' },
);

export function hfRepoToLocalAssetId(repo: string): string {
  const parsed = HfRepoIdSchema.parse(repo);
  return parsed.replace('/', '--');
}

export function localAssetIdToHfRepo(id: string): string {
  const parsed = HubLocalAssetIdSchema.parse(id);
  const sep = parsed.indexOf('--');
  return `${parsed.slice(0, sep)}/${parsed.slice(sep + 2)}`;
}

export const ClientModelIdSchema = z.union([
  z.literal(LEGACY_CLIENT_MODEL_ID),
  HubLocalAssetIdSchema,
]);
export type ClientModelId = z.infer<typeof ClientModelIdSchema>;

/** Asset ids served by GET /api/models/client-assets. */
export const ClientAssetIdSchema = z.union([
  ClientModelIdSchema,
  HunspellAssetIdSchema,
]);
export type ClientAssetId = z.infer<typeof ClientAssetIdSchema>;

export const ClientAssetKindSchema = z.enum(['onnx', 'hunspell']);
export type ClientAssetKind = z.infer<typeof ClientAssetKindSchema>;

export function clientAssetKind(id: string): ClientAssetKind {
  if (HunspellAssetIdSchema.safeParse(id).success) return 'hunspell';
  return 'onnx';
}

/**
 * Closed file allow-list. Nested `onnx/` paths are listed explicitly —
 * `..` is never a member. Every Hub ONNX install uses the same set.
 */
export const CLIENT_ONNX_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'onnx/config.json',
  'onnx/model_q4.onnx',
  'onnx/model_q4.onnx_data',
] as const;

export const CLIENT_ONNX_REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'onnx/model_q4.onnx',
] as const;

export const CLIENT_ONNX_INSTALL_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'onnx/model_q4.onnx',
] as const;

export function clientAssetFiles(id: ClientAssetId): readonly string[] {
  if (id === 'hunspell-en_US') return ['en_US.aff', 'en_US.dic'];
  if (id === 'hunspell-de_DE') return ['de_DE.aff', 'de_DE.dic'];
  return CLIENT_ONNX_FILES;
}

export function clientAssetRequiredFiles(id: ClientAssetId): readonly string[] {
  if (id === 'hunspell-en_US') return ['en_US.aff', 'en_US.dic'];
  if (id === 'hunspell-de_DE') return ['de_DE.aff', 'de_DE.dic'];
  return CLIENT_ONNX_REQUIRED_FILES;
}

export const MAX_CLIENT_ONNX_Q4_BYTES = 1024 * 1024 * 1024;

export const RECOMMENDED_CLIENT_MODELS = [
  { repo: 'onnx-community/Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B Instruct' },
  { repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', label: 'SmolLM2 135M Instruct' },
  { repo: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 360M Instruct' },
  { repo: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3 0.6B' },
] as const;

export const ClientAssetFileSchema = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const ClientAssetManifestEntrySchema = z.object({
  id: ClientAssetIdSchema,
  kind: ClientAssetKindSchema,
  bytes: z.number().int().nonnegative(),
  installed: z.boolean(),
  available: z.boolean(),
  files: z.array(ClientAssetFileSchema),
  repo: z.string().optional(),
  active: z.boolean().optional(),
});

export const ClientAssetManifestSchema = z.object({
  enabled: z.boolean(),
  activeModelId: ClientModelIdSchema.nullable().optional(),
  models: z.array(ClientAssetManifestEntrySchema),
});

export const ClientAssetSearchHitSchema = z.object({
  repo: HfRepoIdSchema,
  downloads: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  recommended: z.boolean(),
});

export const ClientAssetSearchResponseSchema = z.object({
  models: z.array(ClientAssetSearchHitSchema),
});

export const ClientAssetInspectSchema = z.object({
  repo: HfRepoIdSchema,
  hasQ4: z.boolean(),
  bytes: z.number().int().nonnegative(),
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const ClientAssetInstallRequestSchema = z.object({
  repo: HfRepoIdSchema,
});

export const ClientAssetInstallStatusSchema = z.object({
  status: z.enum(['idle', 'running', 'complete', 'failed']),
  repo: z.string().optional(),
  loaded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

export type ClientAssetFile = z.infer<typeof ClientAssetFileSchema>;
export type ClientAssetManifestEntry = z.infer<typeof ClientAssetManifestEntrySchema>;
export type ClientAssetManifest = z.infer<typeof ClientAssetManifestSchema>;
export type ClientAssetSearchHit = z.infer<typeof ClientAssetSearchHitSchema>;
export type ClientAssetSearchResponse = z.infer<typeof ClientAssetSearchResponseSchema>;
export type ClientAssetInspect = z.infer<typeof ClientAssetInspectSchema>;
export type ClientAssetInstallRequest = z.infer<typeof ClientAssetInstallRequestSchema>;
export type ClientAssetInstallStatus = z.infer<typeof ClientAssetInstallStatusSchema>;
