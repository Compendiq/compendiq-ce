import { Agent, fetch as undiciFetch } from 'undici';
import { enqueue } from './llm-queue.js';
import {
  getProviderBreaker,
  invalidateProviderBreaker,
} from '../../../core/services/circuit-breaker.js';
import { logger } from '../../../core/utils/logger.js';

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;           // already normalized to end with /v1
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
}

interface LlmModel { name: string; }
interface HealthResult { connected: boolean; error?: string; }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
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
    // anything?" without re-deriving the routing rules.
    logger.debug({ baseUrl, model }, 'Think requested on a strict provider but model is not reasoning-capable — emitting no extras');
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
};

export interface StreamChatOptions {
  thinking?: boolean;
}

export async function listModels(cfg: ProviderConfig): Promise<LlmModel[]> {
  return enqueue(() =>
    getProviderBreaker(cfg.providerId).execute(async () => {
      const res = await undiciFetch(`${cfg.baseUrl}/models`, {
        headers: headers(cfg), dispatcher: dispatcherFor(cfg),
      });
      if (!res.ok) throw new Error(`listModels HTTP ${res.status}`);
      const body = await res.json() as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => ({ name: m.id }));
    }),
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

export async function chat(
  cfg: ProviderConfig, model: string, messages: ChatMessage[], opts?: StreamChatOptions,
): Promise<string> {
  return enqueue(() =>
    getProviderBreaker(cfg.providerId).execute(async () => {
      const res = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({ model, messages, stream: false, ...thinkingExtras(cfg.baseUrl, model, opts?.thinking) }),
        dispatcher: dispatcherFor(cfg),
      });
      if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
      const body = await res.json() as { choices: Array<{ message: { content: string } }> };
      return body.choices[0]?.message.content ?? '';
    }),
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
  const res = await getProviderBreaker(cfg.providerId).execute(async () => {
    const r = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify({ model, messages, stream: true, ...thinkingExtras(cfg.baseUrl, model, opts?.thinking) }),
      dispatcher: dispatcherFor(cfg),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`streamChat HTTP ${r.status}`);
    return r;
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
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
  yield { content: '', done: true };
}

export async function generateEmbedding(
  cfg: ProviderConfig, model: string, text: string | string[],
): Promise<number[][]> {
  const input = Array.isArray(text) ? text : [text];
  return enqueue(() =>
    getProviderBreaker(cfg.providerId).execute(async () => {
      const res = await undiciFetch(`${cfg.baseUrl}/embeddings`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({ model, input }),
        dispatcher: dispatcherFor(cfg),
      });
      if (!res.ok) throw new Error(`generateEmbedding HTTP ${res.status}`);
      const body = await res.json() as { data: Array<{ embedding: number[] }> };
      return body.data.map((d) => d.embedding);
    }),
  );
}
