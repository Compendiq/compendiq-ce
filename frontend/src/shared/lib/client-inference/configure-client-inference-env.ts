export type OrtWasmPaths = { mjs: string; wasm: string };

export type TransformersEnvLike = {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  remoteHost: string;
  remotePathTemplate: string;
  useBrowserCache: boolean;
  useCustomCache: boolean;
  customCache: unknown;
  fetch: typeof fetch;
  backends: { onnx?: { wasm?: { wasmPaths?: unknown } } };
};

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isSameOriginClientAsset(input: RequestInfo | URL, origin: string): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(requestHref(input), origin);
    return parsed.origin === new URL(origin).origin
      && parsed.pathname.startsWith('/api/models/client-assets/');
  } catch {
    return false;
  }
}

export function wrapAssetFetch(
  accessToken: string | undefined,
  origin: string = (typeof self !== 'undefined' ? self.location?.origin : undefined) ?? '',
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (accessToken && isSameOriginClientAsset(input, origin)) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return fetch(input, { ...init, headers });
  };
}

export function configureClientInferenceEnv(
  env: TransformersEnvLike,
  opts: {
    origin: string;
    wasmPaths: OrtWasmPaths;
    fetch: typeof fetch;
    customCache: { match: (request: string) => Promise<unknown>; put: (request: string, response: Response) => Promise<void> };
  },
): void {
  const wasm = env.backends.onnx?.wasm;
  if (wasm) wasm.wasmPaths = opts.wasmPaths;
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.remoteHost = `${opts.origin.replace(/\/$/, '')}/api/models/client-assets/`;
  env.remotePathTemplate = '{model}/';
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = opts.customCache;
  env.fetch = opts.fetch;
}
