import { query } from '../db/postgres.js';
import { decryptPat } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import {
  streamChat as ollamaStreamChat,
  chat as ollamaChat,
  generateEmbedding as ollamaGenerateEmbedding,
} from './ollama-service.js';
import {
  openaiStreamChat,
  openaiChat,
  openaiGenerateEmbedding,
  type OpenAIConfig,
} from './openai-service.js';
import type { ChatMessage, StreamChunk } from './ollama-service.js';

export type LlmProviderType = 'ollama' | 'openai';

/** Resolved per-user LLM provider configuration. */
export interface ResolvedProvider {
  type: LlmProviderType;
  openaiConfig?: OpenAIConfig;
}

/**
 * Look up the user's configured LLM provider from user_settings.
 * Falls back to 'ollama' if no setting exists.
 */
export async function resolveUserProvider(userId: string): Promise<ResolvedProvider> {
  const result = await query<{
    llm_provider: string;
    openai_base_url: string | null;
    openai_api_key: string | null;
    openai_model: string | null;
  }>(
    'SELECT llm_provider, openai_base_url, openai_api_key, openai_model FROM user_settings WHERE user_id = $1',
    [userId],
  );

  if (result.rows.length === 0 || result.rows[0].llm_provider !== 'openai') {
    return { type: 'ollama' };
  }

  const row = result.rows[0];

  if (!row.openai_api_key || !row.openai_base_url) {
    logger.warn(
      { userId },
      'User has llm_provider=openai but missing base_url or api_key, falling back to ollama',
    );
    return { type: 'ollama' };
  }

  let apiKey: string;
  try {
    apiKey = decryptPat(row.openai_api_key);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to decrypt OpenAI API key, falling back to ollama');
    return { type: 'ollama' };
  }

  return {
    type: 'openai',
    openaiConfig: {
      baseUrl: row.openai_base_url.replace(/\/+$/, ''), // strip trailing slashes
      apiKey,
      model: row.openai_model ?? 'gpt-4o-mini',
    },
  };
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

  if (provider.type === 'openai' && provider.openaiConfig) {
    // For OpenAI, override the model with the user's configured model
    // unless the request explicitly specifies one
    const config: OpenAIConfig = {
      ...provider.openaiConfig,
      model: model || provider.openaiConfig.model,
    };
    yield* openaiStreamChat(config, messages, signal);
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

  if (provider.type === 'openai' && provider.openaiConfig) {
    const config: OpenAIConfig = {
      ...provider.openaiConfig,
      model: model || provider.openaiConfig.model,
    };
    return openaiChat(config, messages);
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

  if (provider.type === 'openai' && provider.openaiConfig) {
    return openaiGenerateEmbedding(provider.openaiConfig, text);
  } else {
    return ollamaGenerateEmbedding(text);
  }
}
