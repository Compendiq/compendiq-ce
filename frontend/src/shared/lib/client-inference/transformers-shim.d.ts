declare module '@huggingface/transformers' {
  export const env: {
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
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<(input: unknown, gen?: Record<string, unknown>) => Promise<unknown>>;
}
