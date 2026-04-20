import { Agent, fetch as undiciFetch } from 'undici';

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

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.authType === 'bearer' && cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
  return h;
}

export async function listModels(cfg: ProviderConfig): Promise<LlmModel[]> {
  const res = await undiciFetch(`${cfg.baseUrl}/models`, {
    headers: headers(cfg), dispatcher: dispatcherFor(cfg),
  });
  if (!res.ok) throw new Error(`listModels HTTP ${res.status}`);
  const body = await res.json() as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => ({ name: m.id }));
}

export async function checkHealth(cfg: ProviderConfig): Promise<HealthResult> {
  try {
    await listModels(cfg);
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}
