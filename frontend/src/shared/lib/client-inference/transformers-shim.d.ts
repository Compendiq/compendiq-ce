declare module '@huggingface/transformers' {
  export const env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    remoteHost: string;
    remotePathTemplate: string;
    useBrowserCache: boolean;
    useWasmCache: boolean;
    useCustomCache: boolean;
    customCache: unknown;
    fetch: typeof fetch;
    backends: { onnx?: { wasm?: { wasmPaths?: unknown } } };
  };
  export interface TextGenerationPipeline {
    (input: unknown, gen?: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<void>;
    tokenizer: {
      chat_template?: string | null;
      apply_chat_template(
        messages: Array<{ role: string; content: string }>,
        options: Record<string, unknown>,
      ): string;
    };
  }
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<TextGenerationPipeline>;
}
