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

export function wrapAssetFetch(accessToken: string | undefined): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
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
