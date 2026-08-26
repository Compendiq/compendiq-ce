declare module '@huggingface/transformers' {
  export const env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    remoteHost: string;
    remotePathTemplate: string;
    useBrowserCache: boolean;
  };
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<(input: unknown, gen?: Record<string, unknown>) => Promise<unknown>>;
}
