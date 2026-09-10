import { describe, expect, it } from 'vitest';
import {
  CLIENT_ONNX_FILES,
  CLIENT_ONNX_REQUIRED_FILES,
  ClientAssetFileSchema,
  ClientAssetIdSchema,
  ClientAssetInspectSchema,
  ClientAssetInstallRequestSchema,
  HunspellInstallRequestSchema,
  ClientAssetInstallStatusSchema,
  ClientAssetManifestSchema,
  ClientAssetSearchResponseSchema,
  ClientModelIdSchema,
  HfRepoIdSchema,
  LEGACY_CLIENT_MODEL_ID,
  MAX_CLIENT_ONNX_Q4_BYTES,
  RECOMMENDED_CLIENT_MODELS,
  clientAssetFiles,
  clientAssetKind,
  hfRepoToLocalAssetId,
  localAssetIdToHfRepo,
} from './client-assets.js';

describe('HfRepoIdSchema', () => {
  it('admits org/name Hub ids', () => {
    expect(HfRepoIdSchema.parse('onnx-community/Qwen2.5-0.5B-Instruct')).toBe(
      'onnx-community/Qwen2.5-0.5B-Instruct',
    );
  });

  it('rejects traversal, extra segments, and reserved attachment names', () => {
    expect(() => HfRepoIdSchema.parse('../etc/passwd')).toThrow();
    expect(() => HfRepoIdSchema.parse('foo/bar/baz')).toThrow();
    expect(() => HfRepoIdSchema.parse('local')).toThrow();
    expect(() => HfRepoIdSchema.parse('page-icons/x')).toThrow();
  });
});

describe('hfRepoToLocalAssetId', () => {
  it('maps a Hub repo to a single URL-segment local id', () => {
    expect(hfRepoToLocalAssetId('onnx-community/Qwen2.5-0.5B-Instruct')).toBe(
      'onnx-community--Qwen2.5-0.5B-Instruct',
    );
    expect(localAssetIdToHfRepo('onnx-community--Qwen2.5-0.5B-Instruct')).toBe(
      'onnx-community/Qwen2.5-0.5B-Instruct',
    );
  });
});

describe('ClientModelIdSchema', () => {
  it('admits the legacy slot and Hub local ids', () => {
    expect(ClientModelIdSchema.parse(LEGACY_CLIENT_MODEL_ID)).toBe(LEGACY_CLIENT_MODEL_ID);
    expect(ClientModelIdSchema.parse('HuggingFaceTB--SmolLM2-135M-Instruct')).toBe(
      'HuggingFaceTB--SmolLM2-135M-Instruct',
    );
    expect(() => ClientModelIdSchema.parse('smollm2-360m-instruct-q4')).toThrow();
    expect(() => ClientModelIdSchema.parse('local')).toThrow();
  });
});

describe('ClientAssetIdSchema', () => {
  it('admits Hunspell packs, the legacy slot, and Hub local ids', () => {
    expect(ClientAssetIdSchema.parse('hunspell-en_US')).toBe('hunspell-en_US');
    expect(ClientAssetIdSchema.parse('hunspell-de_DE')).toBe('hunspell-de_DE');
    expect(ClientAssetIdSchema.parse(LEGACY_CLIENT_MODEL_ID)).toBe(LEGACY_CLIENT_MODEL_ID);
    expect(ClientAssetIdSchema.parse('onnx-community--Qwen2.5-0.5B-Instruct')).toBe(
      'onnx-community--Qwen2.5-0.5B-Instruct',
    );
    expect(() => ClientAssetIdSchema.parse('local')).toThrow();
    expect(() => ClientAssetIdSchema.parse('page-icons')).toThrow();
  });

  it('lists onnx files with no traversal segments', () => {
    for (const name of CLIENT_ONNX_FILES) {
      expect(name.includes('..')).toBe(false);
      expect(name.includes('\\')).toBe(false);
      expect(name.startsWith('/')).toBe(false);
    }
    expect(CLIENT_ONNX_REQUIRED_FILES).toEqual([
      'config.json',
      'tokenizer.json',
      'onnx/model_q4.onnx',
    ]);
  });

  it('classifies Hunspell vs onnx', () => {
    expect(clientAssetKind('hunspell-en_US')).toBe('hunspell');
    expect(clientAssetKind(LEGACY_CLIENT_MODEL_ID)).toBe('onnx');
    expect(clientAssetKind('onnx-community--Qwen2.5-0.5B-Instruct')).toBe('onnx');
    expect(clientAssetFiles('hunspell-en_US')).toEqual(['en_US.aff', 'en_US.dic']);
  });

  it('parses a manifest document with an optional Hub source', () => {
    expect(ClientAssetManifestSchema.parse({
      enabled: false,
      activeModelId: null,
      models: [{
        id: 'hunspell-en_US',
        kind: 'hunspell',
        bytes: 0,
        installed: false,
        available: true,
        files: [],
      }],
    }).enabled).toBe(false);
  });

  it('lists a file without hashing it — sha256 is optional on the hot path', () => {
    expect(ClientAssetFileSchema.parse({ name: 'config.json', bytes: 7 })).toEqual({
      name: 'config.json',
      bytes: 7,
    });
  });
});

describe('RECOMMENDED_CLIENT_MODELS', () => {
  it('lists the curated transformers.js instruct checkpoints', () => {
    expect(RECOMMENDED_CLIENT_MODELS.map((m) => m.repo)).toEqual([
      'onnx-community/Qwen2.5-0.5B-Instruct',
      'HuggingFaceTB/SmolLM2-135M-Instruct',
      'HuggingFaceTB/SmolLM2-360M-Instruct',
      'onnx-community/Qwen3-0.6B-ONNX',
    ]);
  });
});

describe('Hub install wire schemas', () => {
  it('caps q4 weights at 1 GiB', () => {
    expect(MAX_CLIENT_ONNX_Q4_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('parses search, inspect, and install payloads', () => {
    expect(ClientAssetSearchResponseSchema.parse({
      models: [{
        repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
        downloads: 1,
        likes: 0,
        recommended: true,
      }],
    }).models).toHaveLength(1);
    expect(ClientAssetInspectSchema.parse({
      repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
      hasQ4: true,
      bytes: 10,
      ok: true,
    }).ok).toBe(true);
    expect(ClientAssetInstallRequestSchema.parse({
      repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    }).repo).toBe('onnx-community/Qwen2.5-0.5B-Instruct');
    expect(ClientAssetInstallStatusSchema.parse({
      status: 'idle',
      loaded: 0,
      total: 0,
      error: null,
    }).status).toBe('idle');
  });
});

describe('HunspellInstallRequestSchema', () => {
  it('accepts en_US and de_DE ids', () => {
    expect(HunspellInstallRequestSchema.parse({ id: 'hunspell-en_US' })).toEqual({
      id: 'hunspell-en_US',
    });
    expect(HunspellInstallRequestSchema.parse({ id: 'hunspell-de_DE' })).toEqual({
      id: 'hunspell-de_DE',
    });
  });

  it('rejects unknown ids', () => {
    expect(() => HunspellInstallRequestSchema.parse({ id: 'hunspell-fr_FR' })).toThrow();
  });
});
