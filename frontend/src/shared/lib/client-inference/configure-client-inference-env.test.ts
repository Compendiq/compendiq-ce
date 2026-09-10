import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureClientInferenceEnv,
  wrapAssetFetch,
  type TransformersEnvLike,
} from './configure-client-inference-env';

function emptyEnv(): TransformersEnvLike {
  return {
    allowRemoteModels: false,
    allowLocalModels: true,
    remoteHost: 'https://huggingface.co/',
    remotePathTemplate: '{model}/resolve/{revision}/',
    useBrowserCache: true,
    useCustomCache: false,
    customCache: null,
    fetch,
    backends: { onnx: { wasm: { wasmPaths: undefined } } },
  };
}

describe('configureClientInferenceEnv', () => {
  it('points ORT wasm at same-origin paths and never leaves the Hub remote host', () => {
    const env = emptyEnv();
    const cache = { match: async () => undefined, put: async () => undefined };
    configureClientInferenceEnv(env, {
      origin: 'https://kb.example',
      wasmPaths: { mjs: '/assets/ort.mjs', wasm: '/assets/ort.wasm' },
      fetch,
      customCache: cache,
    });
    expect(env.backends.onnx?.wasm?.wasmPaths).toEqual({
      mjs: '/assets/ort.mjs',
      wasm: '/assets/ort.wasm',
    });
    expect(env.remoteHost).toBe('https://kb.example/api/models/client-assets/');
    expect(env.remotePathTemplate).toBe('{model}/');
    expect(env.useCustomCache).toBe(true);
    expect(env.customCache).toBe(cache);
    expect(env.useBrowserCache).toBe(false);
    expect(env.allowLocalModels).toBe(false);
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
