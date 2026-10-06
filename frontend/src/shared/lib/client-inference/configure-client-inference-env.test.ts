import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureClientInferenceEnv,
  wrapAssetFetch,
  type TransformersEnvLike,
} from './configure-client-inference-env';
import { parseClientAssetRequest } from './opfs-model-cache';

describe('same-origin model loading with the installed Transformers runtime', () => {
  it.each([
    'onnx-community--Qwen3-0.6B-ONNX',
    'qwen2.5-0.5b-instruct-q4',
  ])('loads %s cold and reuses its existing cache identity', async (modelId) => {
    const { env, AutoConfig } = await vi.importActual<{
      env: TransformersEnvLike & { useFS: boolean };
      AutoConfig: { from_pretrained(path: string): Promise<{ model_type: string }> };
    }>('@huggingface/transformers');
    const original = { ...env };
    const originalWasmPaths = env.backends.onnx?.wasm?.wasmPaths;
    const modelPath = `/api/models/client-assets/${modelId}`;
    const cached = new Map<string, Response>();
    const cacheKey = (request: string) => {
      const asset = parseClientAssetRequest(request);
      return asset ? `${asset.modelId}/${asset.file}` : '';
    };
    const match = vi.fn(async (request: string) => cached.get(cacheKey(request))?.clone());
    let offline = false;
    const fetchAsset: typeof fetch = async (input) => {
      if (offline) throw new Error('model network disabled');
      if (input !== `${modelPath}/config.json`) throw new Error(`Unexpected model request: ${String(input)}`);
      return Response.json({ model_type: 'qwen3' });
    };
    try {
      // Mirror browser file loading while exercising the real library, not a
      // mocked pipeline that accepts the invalid Hub id containing "--".
      env.useFS = false;
      configureClientInferenceEnv(env, {
        origin: 'https://kb.example',
        wasmPaths: { mjs: '/assets/ort.mjs', wasm: '/assets/ort.wasm' },
        fetch: fetchAsset,
        customCache: {
          match,
          put: async (request, response) => { cached.set(cacheKey(request), response.clone()); },
        },
      });
      expect((await AutoConfig.from_pretrained(modelPath)).model_type).toBe('qwen3');
      expect(cached.has(`${modelId}/config.json`)).toBe(true);
      offline = true;
      match.mockClear();
      expect((await AutoConfig.from_pretrained(modelPath)).model_type).toBe('qwen3');
      expect(match).toHaveBeenCalledWith(`${modelPath}/config.json`);
    } finally {
      Object.assign(env, original);
      if (env.backends.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = originalWasmPaths;
    }
  });
});

describe('wrapAssetFetch', () => {
  const origin = 'https://kb.example';

  afterEach(() => vi.unstubAllGlobals());

  it('attaches the Bearer token transformers.js would omit', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchFn);
    await wrapAssetFetch('tok-1', origin)('/api/models/client-assets/qwen2.5-0.5b-instruct-q4/config.json');
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('does not attach the session JWT to a CDN or other-host fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchFn);
    await wrapAssetFetch('tok-1', origin)('https://cdn.jsdelivr.net/npm/onnxruntime-web/ort.wasm');
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('does not attach the session JWT to same-origin paths outside client-assets', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchFn);
    await wrapAssetFetch('tok-1', origin)(`${origin}/assets/ort-wasm-simd-threaded.jsep.wasm`);
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBeNull();
  });
});
