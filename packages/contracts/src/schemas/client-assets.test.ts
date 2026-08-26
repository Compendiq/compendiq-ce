import { describe, expect, it } from 'vitest';
import {
  CLIENT_ASSET_FILES,
  ClientAssetIdSchema,
  ClientAssetManifestSchema,
  ClientModelIdSchema,
} from './client-assets.js';

describe('ClientModelIdSchema (#1418 SPEC-016)', () => {
  it('admits only qwen2.5-0.5b-instruct-q4', () => {
    expect(ClientModelIdSchema.options).toEqual(['qwen2.5-0.5b-instruct-q4']);
    expect(() => ClientModelIdSchema.parse('smollm2-360m-instruct-q4')).toThrow();
  });
});

describe('ClientAssetIdSchema (#1418 SPEC-032)', () => {
  it('is a closed list of the instruct checkpoint and Hunspell packs', () => {
    expect(ClientAssetIdSchema.options).toEqual([
      'qwen2.5-0.5b-instruct-q4',
      'hunspell-en_US',
      'hunspell-de_DE',
    ]);
    expect(() => ClientAssetIdSchema.parse('local')).toThrow();
    expect(() => ClientAssetIdSchema.parse('page-icons')).toThrow();
  });

  it('lists files with no traversal segments', () => {
    for (const files of Object.values(CLIENT_ASSET_FILES)) {
      for (const name of files) {
        expect(name.includes('..')).toBe(false);
        expect(name.includes('\\')).toBe(false);
        expect(name.startsWith('/')).toBe(false);
      }
    }
  });

  it('parses a manifest document', () => {
    expect(ClientAssetManifestSchema.parse({
      enabled: false,
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
});
