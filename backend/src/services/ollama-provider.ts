/**
 * Ollama LLM provider implementation.
 *
 * Wraps the existing Ollama SDK client in the LlmProvider interface.
 */

import { Ollama } from 'ollama';
import type { Config } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';
import pLimit from 'p-limit';
import { logger } from '../core/utils/logger.js';
import { ollamaBreakers } from '../core/services/circuit-breaker.js';
import type {
  LlmProvider,
  ChatMessage,
  StreamChunk,
  LlmModel,
  HealthResult,
} from './llm-provider.js';

/** Default timeout for Ollama HTTP requests (30 s). */
const OLLAMA_REQUEST_TIMEOUT_MS = 30_000;
/** Streaming requests can take much longer (large articles). Configurable via env. */
const OLLAMA_STREAM_TIMEOUT_MS = parseInt(process.env.LLM_STREAM_TIMEOUT_MS ?? '300000', 10);

/** Whether to verify TLS certificates for LLM connections (default: true). */
const llmVerifySsl = process.env.LLM_VERIFY_SSL !== 'false';

/** Auth type for LLM connections: 'bearer' (default) or 'none'. */
const llmAuthType = (process.env.LLM_AUTH_TYPE ?? 'bearer').toLowerCase();

/**
 * Build an undici Agent that disables TLS verification when LLM_VERIFY_SSL=false.
 * Returns undefined when default TLS behaviour is acceptable.
 */
function buildLlmDispatcher(): Agent | undefined {
  if (!llmVerifySsl) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

const llmDispatcher = buildLlmDispatcher();

/**
 * Fetch wrapper using undici's fetch so the `dispatcher` option is
 * actually honored. Global fetch() silently ignores `dispatcher`, which
 * means LLM_VERIFY_SSL=false had no effect.
 */
const ollamaFetch: typeof fetch = (input, init?) => {
  const hasSignal = init?.signal != null;
  // Streaming requests (large article improvements) can take several minutes;
  // detect stream:true in the body and apply a longer timeout.
  let isStream = false;
  if (!hasSignal && typeof init?.body === 'string') {
    try { isStream = JSON.parse(init.body).stream === true; } catch { /* ignore */ }
  }
  const timeout = isStream ? OLLAMA_STREAM_TIMEOUT_MS : OLLAMA_REQUEST_TIMEOUT_MS;
  return undiciFetch(input as any, {
    ...init,
    signal: hasSignal ? init!.signal : AbortSignal.timeout(timeout),
    dispatcher: llmDispatcher,
  } as any) as unknown as ReturnType<typeof fetch>;
};

function buildOllamaConfig(): Partial<Config> {
  const config: Partial<Config> = {
    host: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    fetch: ollamaFetch,
  };
  if (llmAuthType === 'bearer' && process.env.LLM_BEARER_TOKEN) {
    config.headers = {
      Authorization: `Bearer ${process.env.LLM_BEARER_TOKEN}`,
    };
  }
  return config;
}

// Max 2 concurrent LLM calls
const llmLimit = pLimit(2);

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly client: Ollama;

  constructor(config?: Partial<Config>) {
    this.client = new Ollama(config ?? buildOllamaConfig());
  }

  async checkHealth(): Promise<HealthResult> {
    try {
      await this.client.list();
      return { connected: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.debug({ err }, 'Ollama health check failed');
      return { connected: false, error: message };
    }
  }

  async listModels(): Promise<LlmModel[]> {
    return ollamaBreakers.list.execute(async () => {
      const response = await this.client.list();
      return response.models.map((m) => ({
        name: m.name,
        size: m.size,
        modifiedAt: m.modified_at,
        digest: m.digest,
      }));
    });
  }

  async *streamChat(
    model: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const generator = await ollamaBreakers.chat.execute(() =>
      llmLimit(() =>
        this.client.chat({
          model,
          messages,
          stream: true,
        }),
      ),
    );

    try {
      for await (const part of generator) {
        if (signal?.aborted) {
          if (typeof (generator as unknown as AsyncGenerator).return === 'function') {
            await (generator as unknown as AsyncGenerator).return(undefined);
          }
          return;
        }
        yield {
          content: part.message.content,
          done: part.done,
        };
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        logger.debug('Ollama stream aborted by client disconnect');
        return;
      }
      throw err;
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    return ollamaBreakers.chat.execute(async () => {
      const response = await llmLimit(() =>
        this.client.chat({ model, messages, stream: false }),
      );
      return response.message.content;
    });
  }

  async generateEmbedding(text: string | string[]): Promise<number[][]> {
    return ollamaBreakers.embed.execute(async () => {
      const model = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
      const input = Array.isArray(text) ? text : [text];

      const response = await llmLimit(() =>
        this.client.embed({ model, input }),
      );

      return response.embeddings;
    });
  }
}
