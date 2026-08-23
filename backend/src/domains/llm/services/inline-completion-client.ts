/**
 * #1417 — direct, bounded inline-completion client.
 *
 * This path intentionally bypasses `llm-queue`: a completion requested after
 * a typing pause is useful only while the cursor is still there. It still uses
 * the shared provider auth/TLS infrastructure, per-provider circuit breaker,
 * tracing, and the caller's AbortSignal. The hard 64-token contract and stop
 * list keep the bypass from becoming a second general-purpose generation API.
 */
import { fetch as undiciFetch } from 'undici';
import type { InlineCompletionRequest } from '@compendiq/contracts';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import { withSpan } from '../../../telemetry.js';
import {
  providerRequestInfra,
  LlmHttpError,
  type ProviderConfig,
} from './openai-compatible-client.js';

export const INLINE_COMPLETION_STOP = ['\n', '\n\n', '```'] as const;
export const INLINE_COMPLETION_TIMEOUT_MS = 10_000;

interface ProviderCompletionBody {
  choices?: Array<{
    text?: string;
    message?: { content?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface InlineCompletionResult {
  completion: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  strategy: 'fim' | 'chat';
}

export interface InlineCompletionOptions {
  /** Test seam and future internal override; the route uses the fixed default. */
  timeoutMs?: number;
}

/** Models whose completion endpoint conventionally understands PRE/SUF/MID. */
export function supportsFim(model: string): boolean {
  // Registry-qualified model ids are common (`Qwen/Qwen2.5-Coder-*`), so the
  // coder family match must be allowed to cross a namespace slash.
  return /(?:qwen.*coder|deepseek.*coder|starcoder|codestral|codegemma)/i.test(model);
}

/**
 * Keep only one continuation line. Leading whitespace is meaningful at a
 * cursor (especially in code), so only generated control/fence text is cut.
 */
export function normalizeInlineCompletion(value: string): string {
  return value
    .replace(/\r/g, '')
    .split(/\n|```/, 1)[0]!
    .replace(/<\/?(?:PRE|SUF|MID)>/gi, '');
}

function metadataLines(input: InlineCompletionRequest): string[] {
  return [
    input.title ? `Title: ${input.title}` : null,
    input.spaceKey ? `Space: ${input.spaceKey}` : null,
    input.pageId != null ? `Page ID: ${input.pageId}` : null,
    input.language ? `Language: ${input.language}` : null,
  ].filter((line): line is string => line != null);
}

export async function requestInlineCompletion(
  cfg: ProviderConfig,
  model: string,
  input: InlineCompletionRequest,
  signal: AbortSignal,
  opts: InlineCompletionOptions = {},
): Promise<InlineCompletionResult> {
  const strategy = supportsFim(model) ? 'fim' : 'chat';
  const fim = `<PRE>${input.prefix}<SUF>${input.suffix ?? ''}<MID>`;
  const requestBody = strategy === 'fim'
    ? {
        model,
        prompt: fim,
        max_tokens: input.maxTokens,
        stop: INLINE_COMPLETION_STOP,
        stream: false,
      }
    : {
        model,
        messages: [
          {
            role: 'system',
            content:
              'Continue the text exactly at the cursor. Return only the shortest natural continuation, on one line, with no quotes, explanation, markdown fence, or repeated prefix.',
          },
          {
            role: 'user',
            content: [
              ...metadataLines(input),
              '<PREFIX>',
              input.prefix,
              '</PREFIX>',
              '<SUFFIX>',
              input.suffix ?? '',
              '</SUFFIX>',
            ].join('\n'),
          },
        ],
        max_tokens: input.maxTokens,
        stop: INLINE_COMPLETION_STOP,
        stream: false,
      };
  const endpoint = strategy === 'fim' ? 'completions' : 'chat/completions';
  const deadline = AbortSignal.timeout(
    opts.timeoutMs ?? INLINE_COMPLETION_TIMEOUT_MS,
  );

  return withSpan(
    'llm.inline_completion',
    () => getProviderBreaker(cfg.providerId).execute(async () => {
      const res = await undiciFetch(`${cfg.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: providerRequestInfra.headers(cfg),
        body: JSON.stringify(requestBody),
        dispatcher: providerRequestInfra.dispatcherFor(cfg),
        signal: AbortSignal.any([signal, deadline]),
      });
      if (!res.ok) {
        // A 4xx proves the provider is reachable. Do not let one incompatible
        // model assignment open the provider's shared breaker for chat.
        throw new LlmHttpError(
          'inlineCompletion',
          res.status,
          await providerRequestInfra.errorDetail(res),
          res.status >= 400 && res.status < 500,
        );
      }

      const body = (await res.json()) as ProviderCompletionBody;
      const raw = strategy === 'fim'
        ? body.choices?.[0]?.text
        : body.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') {
        throw new LlmHttpError(
          'inlineCompletion',
          502,
          'provider response carried no completion text',
        );
      }
      const usage = body.usage
        ? {
            promptTokens: body.usage.prompt_tokens,
            completionTokens: body.usage.completion_tokens,
          }
        : undefined;
      let completion = normalizeInlineCompletion(raw);
      if (/\s$/u.test(input.prefix)) completion = completion.replace(/^[\t ]+/u, '');
      return { completion, usage, strategy };
    }),
    {
      'llm.provider_id': cfg.providerId,
      'llm.model': model,
      'llm.inline_completion.strategy': strategy,
    },
  );
}
