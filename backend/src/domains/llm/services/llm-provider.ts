/**
 * LLM Provider abstraction layer.
 *
 * Defines a common interface for LLM backends (Ollama, OpenAI-compatible APIs)
 * so the rest of the application can work with any provider transparently.
 *
 * Also provides per-user provider resolution from user_settings (multi-user support).
 */
import { getSharedLlmSettings } from '../../../core/services/admin-settings-service.js';
import {
  streamChat as ollamaStreamChat,
  chat as ollamaChat,
  generateEmbedding as ollamaGenerateEmbedding,
} from './ollama-service.js';
import { OpenAIProvider } from './openai-service.js';
import { enqueue } from './llm-queue.js';

// ─── Shared interfaces ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface LlmModel {
  name: string;
  size: number;
  modifiedAt: Date;
  digest: string;
}

export interface HealthResult {
  connected: boolean;
  error?: string;
}

/**
 * Common interface that all LLM providers must implement.
 */
export interface LlmProvider {
  readonly name: string;

  /** Check connectivity to the LLM backend. */
  checkHealth(): Promise<HealthResult>;

  /** List available models. */
  listModels(): Promise<LlmModel[]>;

  /** Stream a chat completion, yielding chunks as they arrive. */
  streamChat(
    model: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk>;

  /** Non-streaming chat completion. */
  chat(model: string, messages: ChatMessage[]): Promise<string>;

  /** Generate embeddings for one or more texts. */
  generateEmbedding(text: string | string[]): Promise<number[][]>;
}

export type LlmProviderType = 'ollama' | 'openai';

// ─── Per-user provider resolution ───────────────────────────────────────────

/** Resolved per-user LLM provider configuration. */
export interface ResolvedProvider {
  type: LlmProviderType;
}

// Lazily initialized OpenAI provider instance for per-user routing
let _openaiProvider: OpenAIProvider | null = null;
function getOpenAIProvider(): OpenAIProvider {
  if (!_openaiProvider) _openaiProvider = new OpenAIProvider();
  return _openaiProvider;
}

/**
 * Resolve the shared LLM provider configured by admins.
 * Falls back to 'ollama' if no setting exists.
 */
export async function resolveUserProvider(_userId: string): Promise<ResolvedProvider> {
  const sharedLlmSettings = await getSharedLlmSettings();
  return { type: sharedLlmSettings.llmProvider };
}

/**
 * Stream a chat completion using the user's configured provider.
 * Resolves provider per-request from the database -- no global singleton.
 *
 * NOTE: Streaming calls do NOT pass through `enqueue()` — the llm-queue
 * concurrency limit (`LLM_CONCURRENCY`) and depth cap (`LLM_MAX_QUEUE_DEPTH`)
 * apply to non-streaming calls only. Async iteration cannot be cleanly wrapped
 * in the enqueue() pattern; enforcing backpressure on streams is tracked as a
 * follow-up. For now, heavy concurrent streaming load (many chat/RAG requests
 * or many worker batches) will bypass these guardrails.
 */
export async function* providerStreamChat(
  userId: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const provider = await resolveUserProvider(userId);

  if (provider.type === 'openai') {
    yield* getOpenAIProvider().streamChat(model, messages, signal);
  } else {
    yield* ollamaStreamChat(model, messages, signal);
  }
}

/**
 * Stream a chat completion using an *explicit* provider/model — no per-user
 * resolution. Used by background workers (summary, quality) which have no
 * userId context but need to honor per-use-case provider overrides resolved
 * via `getUsecaseLlmAssignment` (issue #214).
 *
 * Like `providerStreamChat`, this bypasses the `enqueue()` LLM queue. See the
 * note on `providerStreamChat` above. Workers already serialize their LLM
 * calls within a batch (`for ... await` loops), so per-worker the concurrency
 * is 1 — the risk is multiple workers running simultaneously during overlap.
 */
export async function* providerStreamChatForUsecase(
  provider: LlmProviderType,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  if (provider === 'openai') {
    yield* getOpenAIProvider().streamChat(model, messages, signal);
  } else {
    yield* ollamaStreamChat(model, messages, signal);
  }
}

/**
 * Non-streaming chat completion using an *explicit* provider/model — no
 * per-user resolution. Non-streaming sibling of `providerStreamChatForUsecase`,
 * used by the auto-tag path which needs a full response (not a stream) but
 * must honor the per-use-case provider override resolved via
 * `getUsecaseLlmAssignment` (issue #214).
 */
export async function providerChatForUsecase(
  provider: LlmProviderType,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  return enqueue(async () => {
    if (provider === 'openai') {
      return getOpenAIProvider().chat(model, messages);
    } else {
      return ollamaChat(model, messages);
    }
  });
}

/**
 * Generate embeddings using the user's configured provider.
 * For OpenAI, requests the configured embedding dimensions to match the pgvector column.
 */
export async function providerGenerateEmbedding(
  userId: string,
  text: string | string[],
): Promise<number[][]> {
  const provider = await resolveUserProvider(userId);

  if (provider.type === 'openai') {
    return getOpenAIProvider().generateEmbedding(text);
  } else {
    return ollamaGenerateEmbedding(text);
  }
}
