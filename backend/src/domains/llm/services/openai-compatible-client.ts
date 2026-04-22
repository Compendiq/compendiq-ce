import { Agent, fetch as undiciFetch } from 'undici';
import { enqueue } from './llm-queue.js';
import {
  getProviderBreaker,
  invalidateProviderBreaker,
} from '../../../core/services/circuit-breaker.js';

export interface ProviderConfig {
  providerId: string;
  baseUrl: string;           // already normalized to end with /v1
  apiKey: string | null;
  authType: 'bearer' | 'none';
  verifySsl: boolean;
}

export interface LlmModel { name: string; }
export interface HealthResult { connected: boolean; error?: string; }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface StreamChunk { content: string; done: boolean; }

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

export async function chat(cfg: ProviderConfig, model: string, messages: ChatMessage[]): Promise<string> {
  return enqueue(() =>
    getProviderBreaker(cfg.providerId).execute(async () => {
      const res = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({ model, messages, stream: false }),
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
  cfg: ProviderConfig, model: string, messages: ChatMessage[], signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const res = await getProviderBreaker(cfg.providerId).execute(async () => {
    const r = await undiciFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify({ model, messages, stream: true }),
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
