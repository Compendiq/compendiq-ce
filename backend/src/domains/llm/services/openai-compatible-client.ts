import { Agent, fetch as undiciFetch } from 'undici';
// Named import, not the ambient global: `lib: ["ES2022"]` (no `dom`) means the
// global `ReadableStream` comes from `@types/node`'s own declaration, which
// TS treats as structurally incompatible with the `node:stream/web` type
// undici's own `.d.ts` actually uses for `Response.body` (a `pipeThrough`
// generic-variance mismatch) — importing the same module undici types
// against is what makes `boundedErrorDetail`'s parameter type below actually
// accept a real `Response`.
import type { ReadableStream } from 'node:stream/web';
import { enqueue } from './llm-queue.js';
import {
  getProviderBreaker,
  invalidateProviderBreaker,
} from '../../../core/services/circuit-breaker.js';
import { logger } from '../../../core/utils/logger.js';
import { withSpan } from '../../../telemetry.js';
import type { ChatMessage } from './prompts.js';
import { LlmHttpError, ERROR_BODY_MAX_CHARS } from './llm-http-error.js';
export type { ChatMessage, ChatContentPart } from './prompts.js';
export { LlmHttpError } from './llm-http-error.js';

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;           // already normalized to end with /v1
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
}

interface LlmModel { name: string; }
interface HealthResult { connected: boolean; error?: string; }
interface StreamChunk { content: string; done: boolean; }

const dispatchers = new Map<string, Agent>();
function dispatcherFor(cfg: ProviderConfig): Agent | undefined {
  if (cfg.verifySsl) return undefined;
  let d = dispatchers.get(cfg.providerId);
  if (!d) {
    // Intentional: user-gated verifySsl=false flag for self-hosted LLMs with self-signed certs.
    // Per-provider opt-in (never global), see spec docs/superpowers/specs/2026-04-20-multi-llm-providers-design.md §5.1.
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    d = new Agent({ connect: { rejectUnauthorized: false } });
    dispatchers.set(cfg.providerId, d);
  }
  return d;
}

export function invalidateDispatcher(providerId: string): void {
  const d = dispatchers.get(providerId);
  if (d) { void d.close(); dispatchers.delete(providerId); }
}

/**
 * Drop the circuit breaker for a provider. Called alongside
 * `invalidateDispatcher` when a provider's configuration changes (cache-bus
 * bump) so the next request starts with a fresh breaker instead of inheriting
 * stale failure state tied to the old configuration.
 */
export function invalidateBreaker(providerId: string): void {
  invalidateProviderBreaker(providerId);
}

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.authType === 'bearer' && cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  return h;
}

/**
 * Hosts that reject unknown JSON fields on `/chat/completions` (HTTP 400).
 * Exact matches go in `STRICT_HOSTS`; suffix matches (for tenant-scoped
 * cloud deployments) go in `STRICT_HOST_SUFFIXES`.
 *
 * The set is intentionally narrow: every other OpenAI-compatible backend
 * we know about (Ollama, vLLM/SGLang, LM Studio, llama.cpp's server, TGI,
 * Together, Groq, Fireworks, OpenRouter, etc.) ignores unknown fields, so
 * "tolerant" is the safer default. Adding a host here means the toggle
 * silently no-ops rather than 400s for models that don't support reasoning.
 */
const STRICT_HOSTS: ReadonlySet<string> = new Set(['api.openai.com']);
const STRICT_HOST_SUFFIXES: ReadonlyArray<string> = ['.openai.azure.com'];

function isStrictOpenAiCompatibleHost(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  if (STRICT_HOSTS.has(hostname)) return true;
  return STRICT_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * OpenAI models known to accept `reasoning_effort`. Intentionally excludes
 * the `o1` family: `o1`, `o1-preview`, and `o1-mini` shipped before the
 * parameter existed and reject it with 400. The reasoning level on those
 * older models is fixed by the model itself. If a user picks `o1*` and
 * toggles Think on, we'd rather no-op than 400, so they fall through to
 * the strict-non-reasoning branch.
 */
function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /^o[3-9]/.test(m) || m.startsWith('gpt-5');
}

/**
 * Translate a generic `thinking: true` request into the provider-specific
 * extras understood by the upstream `/chat/completions` endpoint.
 *
 * The constraint that drives the shape isn't the model — it's the server's
 * strictness toward unknown fields. We branch on the provider, not on the
 * model name:
 *
 * 1. **Strict providers** (`api.openai.com`, `*.openai.azure.com`): only
 *    emit `reasoning_effort: 'medium'` when the model is recognized as
 *    reasoning-capable (`o[3-9]*`, `gpt-5*`). For everything else
 *    (`gpt-4o`, `gpt-3.5`, the `o1` family, custom fine-tunes) we emit
 *    nothing — the toggle becomes a silent no-op rather than a 400.
 *    Users can still toggle Think; the strict backend just won't reason
 *    on models that can't.
 *
 * 2. **Anything else** (Ollama, vLLM/SGLang, LM Studio, TGI, custom):
 *    always emit `think: true` + `chat_template_kwargs.enable_thinking: true`.
 *    These backends accept arbitrary fields. If the loaded chat template
 *    has a thinking branch (Qwen3, DeepSeek-R1, Magistral, gpt-oss…), the
 *    model reasons; otherwise the fields are ignored. Either way no error,
 *    so any user-installed model works.
 */
function thinkingExtras(
  baseUrl: string,
  model: string,
  thinking?: boolean,
): Record<string, unknown> {
  if (!thinking) return {};
  if (isStrictOpenAiCompatibleHost(baseUrl)) {
    if (isOpenAiReasoningModel(model)) return { reasoning_effort: 'medium' };
    // Leave a debug breadcrumb so support can answer "why didn't Think do
    // anything?" without re-deriving the routing rules. Log the parsed
    // hostname rather than the raw baseUrl — the latter can legally
    // contain credentials (`https://user:pass@host/v1`) per WHATWG URL,
    // which would otherwise leak into centralized log storage.
    let host: string;
    try { host = new URL(baseUrl).hostname; } catch { host = '<invalid>'; }
    logger.debug({ host, model }, 'Think requested on a strict provider but model is not reasoning-capable — emitting no extras');
    return {};
  }
  return { think: true, chat_template_kwargs: { enable_thinking: true } };
}

// Exported for unit testing only — the wire-format assertions on
// `streamChat`/`chat` cover the runtime path, but `thinkingExtras` itself
// has enough branches (strict × non-reasoning, strict × reasoning, tolerant)
// that direct table-driven tests are clearer than mocking three SSE servers.
export const __test_only__ = {
  thinkingExtras,
  isStrictOpenAiCompatibleHost,
  isOpenAiReasoningModel,
  setStreamErrorDetailTimeoutMs: (ms: number) => { streamErrorDetailTimeoutMs = ms; },
  resetStreamErrorDetailTimeoutMs: () => { streamErrorDetailTimeoutMs = DEFAULT_STREAM_ERROR_DETAIL_TIMEOUT_MS; },
};

export interface StreamChatOptions {
  thinking?: boolean;
  /**
   * Caps the reply length, mapped straight to the standard `max_tokens`
   * field. Unlike `thinking`'s provider-specific extras, this field is part
   * of the OpenAI chat-completions spec that every host in `STRICT_HOSTS`
   * already accepts, so it is sent unconditionally — no strict-host gating.
   *
   * Honoured by `chat()` only, not `streamChat()` — the only current caller
   * (the vision probe) uses `chat()`. Wire it into `streamChat()`'s body too
   * if a streaming caller ever needs it; today it would silently no-op there.
   */
  maxTokens?: number;
}

export async function listModels(cfg: ProviderConfig): Promise<LlmModel[]> {
  return withSpan(
    'llm.list_models',
    () => enqueue((signal) =>
      getProviderBreaker(cfg.providerId).execute(async () => {
        const res = await undiciFetch(`${cfg.baseUrl}/models`, {
          headers: headers(cfg), dispatcher: dispatcherFor(cfg), signal,
        });
        if (!res.ok) throw new LlmHttpError('listModels', res.status, await errorDetail(res));
        const body = await res.json() as { data?: Array<{ id: string }> };
        return (body.data ?? []).map((m) => ({ name: m.id }));
      }),
    ),
    { 'llm.provider_id': cfg.providerId },
  );
}

export async function checkHealth(cfg: ProviderConfig): Promise<HealthResult> {
  try {
    await listModels(cfg);
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A bare status cannot be acted on: "this model does not accept image content",
 * "unsupported parameter `max_tokens`", "context length exceeded" and "malformed
 * role" are all 400s, and #1154's vision probe caches a `false` verdict for up
 * to 30 days on the strength of that status. The body is what distinguishes
 * them, so a truncated slice of it is retained — on `LlmHttpError.detail`, not
 * in the message, because the message reaches clients (see `llm-http-error.ts`).
 */
async function errorDetail(res: { text(): Promise<string> }): Promise<string> {
  const body = await res.text().catch(() => '');
  return body.trim().slice(0, ERROR_BODY_MAX_CHARS);
}

/**
 * Bound on `streamChat`'s error-body read (PR #1214 review). `chat` /
 * `listModels` / `generateEmbedding` all run inside `enqueue()`, whose own
 * `AbortController` fires — and, per the Fetch spec, aborts an in-progress
 * body read tied to the same signal — after `LLM_STREAM_TIMEOUT_MS` (default
 * 5 minutes). A stalled error body on those paths is therefore already
 * bounded, and the breaker's `onFailure()`/`isProbing` cleanup still runs
 * once the abort settles the read, just later than usual.
 *
 * `streamChat` deliberately bypasses `enqueue()` (see the doc comment on the
 * function below) and 7 of its 8 production callers pass no `AbortSignal`,
 * so its dispatch has no such backstop: undici's default `bodyTimeout`
 * (~300s) resets on every received byte, so a peer that trickles bytes can
 * hold the read open far longer than that — and since the read happens
 * inside `getProviderBreaker().execute()`, a HALF_OPEN breaker's
 * single-probe gate (`isProbing`) stays held for the same duration,
 * rejecting every other request to that provider with "probe already in
 * flight" instead of the normal fail-fast-and-retry cycle.
 *
 * `streamErrorDetailTimeoutMs` is a `let`, not a `const`, purely so tests can
 * shrink it via `__test_only__` instead of waiting out the production value.
 */
const DEFAULT_STREAM_ERROR_DETAIL_TIMEOUT_MS = 5_000;
let streamErrorDetailTimeoutMs = DEFAULT_STREAM_ERROR_DETAIL_TIMEOUT_MS;

/** Sentinel for `boundedErrorDetail`'s race — distinct from any decoded body
 * text, however unlikely a collision with a literal string would be. */
const BOUNDED_READ_TIMED_OUT = Symbol('boundedErrorDetail timeout');

/**
 * Reads the error body directly off the stream's reader — not via
 * `errorDetail()`'s `res.text()` — so a timeout can cancel the exact same
 * reader that is mid-read. `res.body.cancel()` is NOT equivalent: once
 * `.text()` has acquired its (implicit) reader the stream is locked, and
 * cancelling the *stream* from outside that lock throws `"Invalid state:
 * ReadableStream is locked"` (confirmed empirically against a real undici
 * response) — a no-op that leaves the read running until undici's ~300s
 * `bodyTimeout`. Cancelling through the reader we already own is well-defined
 * mid-read: it resolves the pending `read()` with `done: true` and tears down
 * the socket immediately (also confirmed empirically).
 */
async function boundedErrorDetail(res: { body?: ReadableStream | null }): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();

  // Byte cap on the read itself (PR #1214 review): the value is sliced to
  // ERROR_BODY_MAX_CHARS below anyway, so buffering an arbitrarily large error
  // body — a misbehaving loopback provider can stream hundreds of MB inside
  // the 5s window — buys nothing but memory pressure. The ×4 is UTF-8's
  // maximum bytes per code point, so the bytes we do keep always decode to at
  // least ERROR_BODY_MAX_CHARS characters whenever the body has them: the
  // truncated detail is byte-for-byte what the unbounded read would have
  // produced, including for fully multibyte bodies.
  const maxBytes = ERROR_BODY_MAX_CHARS * 4;

  async function readAll(): Promise<string> {
    // `res.body` is typed `ReadableStream` (undici's own declaration, no
    // generic argument — see the type on this function's parameter), so
    // `reader.read()`'s `value` comes back `any`. Every OpenAI-compatible
    // `/chat/completions` body is bytes on the wire; the cast makes that
    // assumption explicit rather than letting `any` flow silently into
    // `chunks`.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value as Uint8Array);
        totalBytes += (value as Uint8Array).byteLength;
        if (totalBytes > maxBytes) {
          // Already more than the slice below can use — stop buffering and
          // tear the upstream connection down, mirroring the timeout path.
          await reader.cancel().catch(() => { /* already closed / benign cancel race */ });
          break;
        }
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof BOUNDED_READ_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(BOUNDED_READ_TIMED_OUT), streamErrorDetailTimeoutMs);
  });

  const winner = await Promise.race([readAll().catch(() => ''), timeoutPromise]);
  if (winner === BOUNDED_READ_TIMED_OUT) {
    await reader.cancel().catch(() => { /* already closed / benign cancel race */ });
    return '';
  }
  clearTimeout(timer);
  return winner.trim().slice(0, ERROR_BODY_MAX_CHARS);
}

export async function chat(
  cfg: ProviderConfig, model: string, messages: ChatMessage[], opts?: StreamChatOptions,
): Promise<string> {
  // The span wraps the queue wait + breaker + HTTP round-trip. With OTel's
  // undici auto-instrumentation enabled the HTTP call appears as a child
  // span, so queue wait is derivable as the difference. No-op when OTel is
  // disabled (withSpan passes straight through).
  return withSpan(
    'llm.chat',
    () => enqueue((signal) =>
      getProviderBreaker(cfg.providerId).execute(async () => {
        const res = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(cfg),
          body: JSON.stringify({
            model, messages, stream: false,
            ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
            ...thinkingExtras(cfg.baseUrl, model, opts?.thinking),
          }),
          dispatcher: dispatcherFor(cfg),
          signal,
        });
        if (!res.ok) throw new LlmHttpError('chat', res.status, await errorDetail(res));
        const body = await res.json() as { choices: Array<{ message: { content: string } }> };
        return body.choices[0]?.message.content ?? '';
      }),
    ),
    { 'llm.provider_id': cfg.providerId, 'llm.model': model },
  );
}

/**
 * Streaming calls intentionally bypass the `enqueue()` LLM queue. Async
 * iteration does not compose cleanly with the `enqueue(fn)` pattern (the queue
 * slot would be held open for the entire stream duration, not just the request
 * dispatch), so streaming inherits the same "backpressure bypass" behavior as
 * the legacy `providerStreamChat`. The per-provider circuit breaker still
 * wraps the initial HTTP request so a failing provider will trip and short-
 * circuit subsequent calls.
 */
export async function* streamChat(
  cfg: ProviderConfig, model: string, messages: ChatMessage[], signal?: AbortSignal, opts?: StreamChatOptions,
): AsyncGenerator<StreamChunk> {
  // The span covers only the dispatch (breaker + initial HTTP request), not
  // the stream consumption — a span held open for the whole stream would
  // outlive minutes-long generations and skew duration percentiles.
  const res = await withSpan(
    'llm.stream_chat.dispatch',
    () => getProviderBreaker(cfg.providerId).execute(async () => {
      const r = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({ model, messages, stream: true, ...thinkingExtras(cfg.baseUrl, model, opts?.thinking) }),
        dispatcher: dispatcherFor(cfg),
        signal,
      });
      if (!r.ok || !r.body) throw new LlmHttpError('streamChat', r.status, await boundedErrorDetail(r));
      return r;
    }),
    { 'llm.provider_id': cfg.providerId, 'llm.model': model },
  );
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  // The try/finally guarantees teardown on ANY exit — including the early
  // generator.return() the runtime triggers when a consumer stops iterating
  // (e.g. streamSSE breaks its loop on client disconnect). reader.cancel()
  // aborts the undici body and destroys the socket, so an abandoned stream no
  // longer leaves the upstream backend generating (GPU slot / billed tokens).
  // On normal completion the stream is already drained, so cancel() is a no-op.
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!frame.startsWith('data:')) continue;
        const data = frame.slice(5).trim();
        if (data === '[DONE]') { yield { content: '', done: true }; return; }
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = parsed.choices?.[0]?.delta?.content ?? '';
          if (content) yield { content, done: false };
        } catch { /* ignore parse errors on malformed frames */ }
      }
    }
  } finally {
    await reader.cancel().catch(() => { /* already closed / benign cancel race */ });
  }
  yield { content: '', done: true };
}

export async function generateEmbedding(
  cfg: ProviderConfig, model: string, text: string | string[],
): Promise<number[][]> {
  const input = Array.isArray(text) ? text : [text];
  return withSpan(
    'llm.embeddings',
    () => enqueue((signal) =>
      getProviderBreaker(cfg.providerId).execute(async () => {
        const res = await undiciFetch(`${cfg.baseUrl}/embeddings`, {
          method: 'POST',
          headers: headers(cfg),
          body: JSON.stringify({ model, input }),
          dispatcher: dispatcherFor(cfg),
          signal,
        });
        if (!res.ok) {
          // The response body is what lets callers (embedding-service's
          // isContextLengthError) detect oversized-input errors such as
          // Ollama's "input length exceeds context length" — it lives on
          // `.detail`, not `.message`, per llm-http-error.ts.
          //
          // #867: a deterministic client-input 4xx (a context-length 400)
          // proves the provider is reachable — it is NOT an outage.
          // `bypassCircuitBreaker: true` on a 400 makes the per-provider
          // circuit breaker treat it as a healthy signal instead of a
          // failure; otherwise one oversized page's repeated 400s open the
          // breaker and abort the whole embedding run.
          throw new LlmHttpError(
            'generateEmbedding', res.status, await errorDetail(res), res.status === 400,
          );
        }
        const body = await res.json() as { data: Array<{ embedding: number[] }> };
        return body.data.map((d) => d.embedding);
      }),
    ),
    { 'llm.provider_id': cfg.providerId, 'llm.model': model, 'llm.input_count': input.length },
  );
}
