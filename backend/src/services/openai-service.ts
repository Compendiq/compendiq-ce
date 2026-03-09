import { Agent, request as undiciRequest } from 'undici';
import pLimit from 'p-limit';
import { logger } from '../utils/logger.js';
import { openaiBreakers } from './circuit-breaker.js';
import type { ChatMessage, StreamChunk } from './ollama-service.js';

/**
 * Required dimension for pgvector column (vector(768)).
 * OpenAI's text-embedding-3-small supports a `dimensions` parameter
 * to truncate output to the requested size.
 */
export const REQUIRED_EMBEDDING_DIMENSIONS = 768;

// Max 2 concurrent OpenAI calls (matches Ollama limit)
const llmLimit = pLimit(2);

/** Per-user OpenAI configuration resolved from user_settings. */
export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Build an undici Agent that respects LLM_VERIFY_SSL.
 * Uses the same pattern as tls-config.ts for Confluence connections.
 */
function buildOpenAIDispatcher(): Agent | undefined {
  const verifySsl = process.env.LLM_VERIFY_SSL !== 'false';
  if (!verifySsl) {
    logger.warn('LLM_VERIFY_SSL=false — TLS certificate verification is disabled for OpenAI-compatible connections');
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

const openaiDispatcher = buildOpenAIDispatcher();

/**
 * Make an HTTP request to an OpenAI-compatible endpoint, respecting
 * LLM_VERIFY_SSL via the undici dispatcher.
 */
async function openaiRequest(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  const opts: Record<string, unknown> = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(120_000),
  };
  if (openaiDispatcher) {
    opts.dispatcher = openaiDispatcher;
  }

  const { statusCode, headers, body: responseBody } = await undiciRequest(
    url,
    opts as Parameters<typeof undiciRequest>[1],
  );

  // Read the body as text for non-streaming responses
  const text = await responseBody.text();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`OpenAI API error ${statusCode}: ${text.slice(0, 500)}`);
  }

  return new Response(text, {
    status: statusCode,
    headers: Object.fromEntries(
      Object.entries(headers).filter(([, v]) => typeof v === 'string') as [string, string][],
    ),
  });
}

/**
 * Make a streaming HTTP request to an OpenAI-compatible endpoint.
 * Returns the raw undici response body for SSE parsing.
 */
async function openaiStreamRequest(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof undiciRequest>>> {
  const opts: Record<string, unknown> = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: signal ?? AbortSignal.timeout(120_000),
  };
  if (openaiDispatcher) {
    opts.dispatcher = openaiDispatcher;
  }

  const response = await undiciRequest(
    url,
    opts as Parameters<typeof undiciRequest>[1],
  );

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const text = await response.body.text();
    throw new Error(`OpenAI API error ${response.statusCode}: ${text.slice(0, 500)}`);
  }

  return response;
}

/**
 * Stream chat completion from an OpenAI-compatible API.
 * Uses separate circuit breakers from Ollama.
 */
export async function* openaiStreamChat(
  config: OpenAIConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const response = await openaiBreakers.chat.execute(() =>
    llmLimit(() =>
      openaiStreamRequest(
        `${config.baseUrl}/v1/chat/completions`,
        {
          model: config.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
        config.apiKey,
        signal,
      ),
    ),
  );

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) {
        // Drain the rest of the body
        response.body.destroy();
        return;
      }

      buffer += decoder.decode(chunk as Buffer, { stream: true });
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
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const content = parsed.choices?.[0]?.delta?.content ?? '';
          const done = parsed.choices?.[0]?.finish_reason != null;
          if (content || done) {
            yield { content, done };
          }
        } catch {
          // Skip malformed SSE lines
          logger.debug({ data: data.slice(0, 100) }, 'Skipping malformed SSE line from OpenAI');
        }
      }
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      logger.debug('OpenAI stream aborted by client disconnect');
      return;
    }
    throw err;
  }
}

/**
 * Non-streaming chat completion from an OpenAI-compatible API.
 */
export async function openaiChat(config: OpenAIConfig, messages: ChatMessage[]): Promise<string> {
  return openaiBreakers.chat.execute(async () => {
    const response = await llmLimit(() =>
      openaiRequest(
        `${config.baseUrl}/v1/chat/completions`,
        {
          model: config.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
        config.apiKey,
      ),
    );

    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? '';
  });
}

/**
 * Generate embeddings from an OpenAI-compatible API.
 * Requests exactly REQUIRED_EMBEDDING_DIMENSIONS (768) dimensions
 * to match the pgvector column definition.
 */
export async function openaiGenerateEmbedding(
  config: OpenAIConfig,
  text: string | string[],
  embeddingModel?: string,
): Promise<number[][]> {
  return openaiBreakers.embed.execute(async () => {
    const input = Array.isArray(text) ? text : [text];
    const model = embeddingModel ?? 'text-embedding-3-small';

    const response = await llmLimit(() =>
      openaiRequest(
        `${config.baseUrl}/v1/embeddings`,
        {
          model,
          input,
          dimensions: REQUIRED_EMBEDDING_DIMENSIONS,
        },
        config.apiKey,
      ),
    );

    const json = await response.json() as {
      data?: Array<{ embedding: number[] }>;
    };

    const embeddings = json.data?.map((d) => d.embedding) ?? [];

    // Validate dimensions
    for (const emb of embeddings) {
      if (emb.length !== REQUIRED_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding dimension mismatch: got ${emb.length}, expected ${REQUIRED_EMBEDDING_DIMENSIONS}. ` +
          `The pgvector column is defined as vector(${REQUIRED_EMBEDDING_DIMENSIONS}). ` +
          `Model '${model}' may not support the 'dimensions' parameter.`,
        );
      }
    }

    return embeddings;
  });
}
