/**
 * LLM Provider abstraction layer.
 *
 * Defines a common interface for LLM backends (Ollama, OpenAI-compatible APIs)
 * so the rest of the application can work with any provider transparently.
 *
 * Also provides per-user provider resolution from user_settings (multi-user support).
 */

import { query } from '../core/db/postgres.js';
import { logger } from '../core/utils/logger.js';
import {
  streamChat as ollamaStreamChat,
  chat as ollamaChat,
  generateEmbedding as ollamaGenerateEmbedding,
} from './ollama-service.js';
import { OpenAIProvider } from './openai-service.js';

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
 * Look up the user's configured LLM provider from user_settings.
 * Falls back to 'ollama' if no setting exists.
 */
export async function resolveUserProvider(userId: string): Promise<ResolvedProvider> {
  const result = await query<{
    llm_provider: string;
  }>(
    'SELECT llm_provider FROM user_settings WHERE user_id = $1',
    [userId],
  );

  if (result.rows.length === 0 || result.rows[0].llm_provider !== 'openai') {
    return { type: 'ollama' };
  }

  return { type: 'openai' };
}

/**
 * Stream a chat completion using the user's configured provider.
 * Resolves provider per-request from the database -- no global singleton.
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
 * Non-streaming chat completion using the user's configured provider.
 */
export async function providerChat(
  userId: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const provider = await resolveUserProvider(userId);

  if (provider.type === 'openai') {
    return getOpenAIProvider().chat(model, messages);
  } else {
    return ollamaChat(model, messages);
  }
}

/**
 * Generate embeddings using the user's configured provider.
 * For OpenAI, requests exactly 768 dimensions to match pgvector column.
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
