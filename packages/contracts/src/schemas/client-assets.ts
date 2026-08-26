import { z } from 'zod';

/**
 * #1418 SPEC-016 — the one generative checkpoint in VRAM.
 * Hunspell dictionaries are a different asset class (SPEC-032).
 */
export const ClientModelIdSchema = z.enum(['qwen2.5-0.5b-instruct-q4']);
export type ClientModelId = z.infer<typeof ClientModelIdSchema>;

/** Asset ids served by GET /api/models/client-assets (SPEC-032). */
export const ClientAssetIdSchema = z.enum([
  'qwen2.5-0.5b-instruct-q4',
  'hunspell-en_US',
  'hunspell-de_DE',
]);
export type ClientAssetId = z.infer<typeof ClientAssetIdSchema>;

export const ClientAssetKindSchema = z.enum(['onnx', 'hunspell']);
export type ClientAssetKind = z.infer<typeof ClientAssetKindSchema>;

export const CLIENT_ASSET_KIND: Record<ClientAssetId, ClientAssetKind> = {
  'qwen2.5-0.5b-instruct-q4': 'onnx',
  'hunspell-en_US': 'hunspell',
  'hunspell-de_DE': 'hunspell',
};

/**
 * Closed file allow-list per asset id. Nested `onnx/` paths are listed
 * explicitly — `..` is never a member.
 */
export const CLIENT_ASSET_FILES: Record<ClientAssetId, readonly string[]> = {
  'qwen2.5-0.5b-instruct-q4': [
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'added_tokens.json',
    'onnx/config.json',
    'onnx/model_q4.onnx',
    'onnx/model_q4f16.onnx',
    'onnx/model.onnx',
    'onnx/model_quantized.onnx',
  ],
  'hunspell-en_US': ['en_US.aff', 'en_US.dic'],
  'hunspell-de_DE': ['de_DE.aff', 'de_DE.dic'],
};

export const CLIENT_ASSET_REQUIRED_FILES: Record<ClientAssetId, readonly string[]> = {
  'qwen2.5-0.5b-instruct-q4': [
    'config.json',
    'tokenizer.json',
    'onnx/model_q4.onnx',
  ],
  'hunspell-en_US': ['en_US.aff', 'en_US.dic'],
  'hunspell-de_DE': ['de_DE.aff', 'de_DE.dic'],
};

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
});

export const ClientAssetManifestSchema = z.object({
  enabled: z.boolean(),
  models: z.array(ClientAssetManifestEntrySchema),
});

export type ClientAssetFile = z.infer<typeof ClientAssetFileSchema>;
export type ClientAssetManifestEntry = z.infer<typeof ClientAssetManifestEntrySchema>;
export type ClientAssetManifest = z.infer<typeof ClientAssetManifestSchema>;
