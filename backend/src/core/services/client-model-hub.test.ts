import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listClientAssetManifest } from './client-model-assets.js';
import {
  HUNSPELL_SOURCES,
  inspectClientModel,
  installClientModel,
  installHunspellModel,
  resetClientModelInstallForTests,
  searchClientModels,
} from './client-model-hub.js';
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('searchClientModels', () => {
  it('returns recommended models when the query is empty without calling Hub', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('Hub must not be contacted for an empty query');
    };
    const result = await searchClientModels('', { fetch: fetchImpl });
    expect(result.models.every((m) => m.recommended)).toBe(true);
    expect(result.models.map((m) => m.repo)).toContain('onnx-community/Qwen2.5-0.5B-Instruct');
  });

  it('filters Hub hits to transformers.js text-generation and marks recommended', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/models?')) {
        expect(url).toContain('pipeline_tag=text-generation');
        expect(url).toContain('filter=transformers.js');
        expect(url).toContain('search=qwen');
        return jsonResponse([
          { id: 'onnx-community/Qwen2.5-0.5B-Instruct', downloads: 10, likes: 2 },
          { id: 'onnx-community/Qwen3-0.6B-ONNX', downloads: 5, likes: 1 },
          { id: 'onnx-community/Too-Large-Model', downloads: 20, likes: 5 },
          { id: 'onnx-community/No-ONNX-Model', downloads: 15, likes: 3 },
          { id: '../evil/model', downloads: 99, likes: 0 },
        ]);
      }
      if (url.includes('Too-Large-Model/tree/main/onnx')) {
        return jsonResponse([{ path: 'onnx/model_q4.onnx', size: 2_000_000_000, type: 'file' }]);
      }
      if (url.includes('No-ONNX-Model/tree/main/onnx')) {
        return new Response('Not Found', { status: 404 });
      }
      return jsonResponse([{ path: 'onnx/model_q4.onnx', size: 100, type: 'file' }]);
    };
    const result = await searchClientModels('qwen', { fetch: fetchImpl });
    expect(result.models.map((m) => m.repo)).toEqual([
      'onnx-community/Qwen2.5-0.5B-Instruct',
      'onnx-community/Qwen3-0.6B-ONNX',
    ]);
    expect(result.models[0]?.recommended).toBe(true);
  });
});
describe('inspectClientModel', () => {
  it('allows a q4 weight at or under 1 GiB', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse([
      { path: 'onnx/model_q4.onnx', size: 100, type: 'file' },
      { path: 'onnx/model.onnx', size: 2_000_000_000, type: 'file' },
    ]);
    const result = await inspectClientModel('onnx-community/Qwen2.5-0.5B-Instruct', { fetch: fetchImpl });
    expect(result).toEqual({
      repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
      hasQ4: true,
      bytes: 100,
      ok: true,
    });
  });

  it('rejects a missing q4 or a q4 over 1 GiB', async () => {
    const missing = await inspectClientModel('onnx-community/Qwen3-0.6B-ONNX', {
      fetch: async () => jsonResponse([{ path: 'onnx/model.onnx', size: 10, type: 'file' }]),
    });
    expect(missing.ok).toBe(false);
    expect(missing.hasQ4).toBe(false);

    const huge = await inspectClientModel('onnx-community/Qwen3-0.6B-ONNX', {
      fetch: async () => jsonResponse([{
        path: 'onnx/model_q4.onnx',
        size: 1024 * 1024 * 1024 + 1,
        type: 'file',
      }]),
    });
    expect(huge.ok).toBe(false);
    expect(huge.hasQ4).toBe(true);
    expect(huge.bytes).toBe(1024 * 1024 * 1024 + 1);
  });
});

describe('installClientModel', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'client-hub-'));
    process.env.CLIENT_MODEL_ASSETS_DIR = tmp;
    resetClientModelInstallForTests();
  });

  afterEach(async () => {
    resetClientModelInstallForTests();
    delete process.env.CLIENT_MODEL_ASSETS_DIR;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes required files onto the volume and marks the Hub id active', async () => {
    const files: Record<string, string> = {
      'config.json': '{"ok":true}',
      'tokenizer.json': '{}',
      'onnx/model_q4.onnx': 'ONNX',
    };
    const sha = createHash('sha256').update('ONNX').digest('hex');
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/tree/main/onnx')) {
        return jsonResponse([{
          path: 'onnx/model_q4.onnx',
          size: 4,
          type: 'file',
          lfs: { oid: sha, size: 4 },
        }]);
      }
      for (const [name, body] of Object.entries(files)) {
        if (url.endsWith(`/${name}`) || url.endsWith(name)) {
          return new Response(body, { status: 200 });
        }
      }
      return new Response(null, { status: 404 });
    };
    await installClientModel('onnx-community/Qwen2.5-0.5B-Instruct', { fetch: fetchImpl, root: tmp });
    const manifest = await listClientAssetManifest(true, tmp);
    expect(manifest.activeModelId).toBe('onnx-community--Qwen2.5-0.5B-Instruct');
    const onnx = manifest.models.find((m) => m.id === manifest.activeModelId);
    expect(onnx?.installed).toBe(true);
  });

  it('does not leave a partial tree when the q4 hash mismatches', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/tree/main/onnx')) {
        return jsonResponse([{
          path: 'onnx/model_q4.onnx',
          size: 4,
          type: 'file',
          lfs: { oid: 'a'.repeat(64), size: 4 },
        }]);
      }
      if (url.includes('model_q4.onnx')) return new Response('ONNX', { status: 200 });
      if (url.includes('config.json') || url.includes('tokenizer.json')) {
        return new Response('{}', { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    await expect(installClientModel('onnx-community/Qwen2.5-0.5B-Instruct', {
      fetch: fetchImpl,
      root: tmp,
    })).rejects.toThrow(/sha256/i);
    const manifest = await listClientAssetManifest(true, tmp);
    expect(manifest.activeModelId).toBeNull();
  });
});

describe('installHunspellModel', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hunspell-install-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('has valid upstream URLs for all Hunspell sources', () => {
    for (const [id, source] of Object.entries(HUNSPELL_SOURCES)) {
      expect(source.files.length).toBeGreaterThan(0);
      for (const file of source.files) {
        expect(file.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/wooorm\/dictionaries\/main\/dictionaries\//);
        // Ensure english points to /en/ directory, not /en-US/ which 404s
        if (id === 'hunspell-en_US') {
          expect(file.url).toContain('/dictionaries/en/');
        }
      }
    }
  });

  it('downloads aff and dic files and marks the hunspell model installed', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('en/index.aff')) return new Response('SET UTF-8', { status: 200 });
      if (url.includes('en/index.dic')) return new Response('1\nhello', { status: 200 });
      return new Response(null, { status: 404 });
    };

    await installHunspellModel('hunspell-en_US', { fetch: fetchImpl, root: tmp });
    const manifest = await listClientAssetManifest(true, tmp);
    const hunspell = manifest.models.find((m) => m.id === 'hunspell-en_US');
    expect(hunspell?.installed).toBe(true);
    expect(hunspell?.files).toHaveLength(2);
  });
  it('cleans up partial files on network failure', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('index.aff')) return new Response('SET UTF-8', { status: 200 });
      return new Response(null, { status: 500 });
    };

    await expect(installHunspellModel('hunspell-en_US', { fetch: fetchImpl, root: tmp })).rejects.toThrow();
    const manifest = await listClientAssetManifest(true, tmp);
    const hunspell = manifest.models.find((m) => m.id === 'hunspell-en_US');
    expect(hunspell?.installed).toBe(false);
  });
});
