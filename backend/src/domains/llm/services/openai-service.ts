/**
 * OpenAI-compatible API provider.
 *
 * Implements the LlmProvider interface using the standard OpenAI chat/completions
 * and embeddings API. Works with any OpenAI-compatible endpoint (OpenAI, Azure OpenAI,
 * LM Studio, vLLM, llama.cpp server, LocalAI, etc.).
 *
 * Configuration via environment variables:
 *   OPENAI_BASE_URL  - API base URL (default: https://api.openai.com/v1)
 *   LLM_BEARER_TOKEN - API key (preferred, shared with Ollama provider)
 *   OPENAI_API_KEY   - API key (fallback)
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from '../../../core/utils/logger.js';
import { openaiBreakers } from '../../../core/services/circuit-breaker.js';
import pLimit from 'p-limit';
import { getSharedLlmSettings } from '../../../core/services/admin-settings-service.js';
import type {
  LlmProvider,
  ChatMessage,
  StreamChunk,
  LlmModel,
  HealthResult,
} from './llm-provider.js';

const REQUEST_TIMEOUT_MS = 60_000;
/** Streaming requests can take much longer (large articles). Configurable via env. */
const STREAM_TIMEOUT_MS = parseInt(process.env.LLM_STREAM_TIMEOUT_MS ?? '300000', 10);

// Max 2 concurrent LLM calls (same as Ollama)
const llmLimit = pLimit(2);

/** Whether to verify TLS certificates for LLM connections (default: true). */
const llmVerifySsl = process.env.LLM_VERIFY_SSL !== 'false';

/**
 * Build an undici Agent that disables TLS verification when LLM_VERIFY_SSL=false.
 * Returns undefined when default TLS behaviour is acceptable.
 */
function buildLlmDispatcher(): Agent | undefined {
  if (!llmVerifySsl) {
    logger.warn('LLM_VERIFY_SSL=false — TLS certificate verification is disabled for OpenAI-compatible connections');
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

const llmDispatcher = buildLlmDispatcher();

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
}

async function getConfig(): Promise<OpenAIConfig> {
  const sharedLlmSettings = await getSharedLlmSettings();
  return {
    baseUrl: (sharedLlmSettings.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: sharedLlmSettings.openaiApiKey ?? process.env.LLM_BEARER_TOKEN ?? process.env.OPENAI_API_KEY ?? '',
  };
}

function makeHeaders(config: OpenAIConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

/**
 * Fetch wrapper using undici's fetch so the `dispatcher` option is
 * actually honored. Global fetch() silently ignores `dispatcher`, which
 * means LLM_VERIFY_SSL=false had no effect.
 */
function llmFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    dispatcher: llmDispatcher,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici fetch types differ from global fetch
  } as any) as unknown as Promise<Response>;
}

async function openaiRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const config = await getConfig();
  const url = `${config.baseUrl}${path}`;
  const headers = makeHeaders(config);

  return llmFetch(url, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(llmDispatcher ? { dispatcher: llmDispatcher } : {}),
  } as RequestInit);
}

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';

  async checkHealth(): Promise<HealthResult> {
    try {
      const response = await openaiRequest('/models');
      if (response.ok) {
        return { connected: true };
      }
      const text = await response.text();
      return { connected: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.debug({ err }, 'OpenAI health check failed');
      return { connected: false, error: message };
    }
  }

  async listModels(): Promise<LlmModel[]> {
    return openaiBreakers.list.execute(async () => {
      const response = await openaiRequest('/models');
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to list models: HTTP ${response.status} - ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        data: Array<{
          id: string;
          created?: number;
          owned_by?: string;
        }>;
      };

      return data.data.map((m) => ({
        name: m.id,
        size: 0,
        modifiedAt: m.created ? new Date(m.created * 1000) : new Date(),
        digest: m.owned_by ?? '',
      }));
    });
  }

  async *streamChat(
    model: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const generator = await openaiBreakers.chat.execute(() =>
      llmLimit(async () => {
        const response = await openaiRequest(
          '/chat/completions',
          {
            model,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
          },
          signal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS),
        );

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Chat request failed: HTTP ${response.status} - ${text.slice(0, 200)}`);
        }

        return response;
      }),
    );

    const reader = generator.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          return;
        }

        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
              }>;
            };

            const choice = parsed.choices?.[0];
            if (choice?.delta?.content) {
              yield {
                content: choice.delta.content,
                done: choice.finish_reason != null,
              };
            } else if (choice?.finish_reason) {
              yield { content: '', done: true };
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.debug('OpenAI stream aborted by client disconnect');
        return;
      }
      throw err;
    } finally {
      reader.releaseLock();
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    return openaiBreakers.chat.execute(async () => {
      return llmLimit(async () => {
        const response = await openaiRequest('/chat/completions', {
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Chat request failed: HTTP ${response.status} - ${text.slice(0, 200)}`);
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };

        return data.choices[0]?.message?.content ?? '';
      });
    });
  }

  async generateEmbedding(text: string | string[]): Promise<number[][]> {
    return openaiBreakers.embed.execute(async () => {
      return llmLimit(async () => {
        const input = Array.isArray(text) ? text : [text];

        const REQUIRED_DIMS = 768;
        const response = await openaiRequest('/embeddings', {
          model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
          input,
          dimensions: REQUIRED_DIMS,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Embedding request failed: HTTP ${response.status} - ${errText.slice(0, 200)}`);
        }

        const data = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        // Sort by index to ensure correct order
        const embeddings = data.data
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);

        // Validate dimensions match pgvector column
        if (embeddings.length > 0 && embeddings[0].length !== REQUIRED_DIMS) {
          throw new Error(
            `Embedding dimension mismatch: got ${embeddings[0].length}, expected ${REQUIRED_DIMS} (pgvector column is vector(${REQUIRED_DIMS}))`,
          );
        }

        return embeddings;
      });
    });
  }
}
