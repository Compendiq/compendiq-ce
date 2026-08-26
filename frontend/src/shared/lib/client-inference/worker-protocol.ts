import type { ClientModelId } from '@compendiq/contracts';

export type ClientInferenceErrorCode = 'webgpu' | 'oom' | 'timeout' | 'aborted' | 'load';

export type WorkerRequest =
  | { id: string; type: 'load'; modelId: ClientModelId }
  | { id: string; type: 'complete'; prefix: string; suffix?: string; maxTokens: number }
  | { id: string; type: 'rewrite'; task: 'grammar' | 'clarity' | 'completeness'; instruction?: string; text: string }
  | { id: string; type: 'abort'; targetId: string }
  | { id: string; type: 'unload' };

export type WorkerEvent =
  | { id: string; type: 'progress'; loaded: number; total: number }
  | { id: string; type: 'ready'; modelId: ClientModelId }
  | { id: string; type: 'result'; text: string }
  | { id: string; type: 'error'; code: ClientInferenceErrorCode; message: string };

export const CLIENT_INFERENCE_MODEL_ID = 'qwen2.5-0.5b-instruct-q4' as const;
export const IDLE_UNLOAD_MS = 5 * 60 * 1000;
export const LOCAL_COMPLETION_MODEL = `client:${CLIENT_INFERENCE_MODEL_ID}`;
export const LOCAL_COMPLETION_PROVIDER = 'webgpu';
