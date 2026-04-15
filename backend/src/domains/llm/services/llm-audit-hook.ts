/**
 * LLM audit hook extension point.
 *
 * In CE mode: no hook is registered, emitLlmAudit is a zero-overhead no-op.
 * In EE mode: the enterprise plugin calls setLlmAuditHook to register a writer.
 */

export interface LlmAuditEntry {
  userId: string | null;
  action: 'chat' | 'ask' | 'improve' | 'generate' | 'summarize' | 'embed' | 'quality' | 'tag' | 'diagram';
  model: string;
  provider: 'ollama' | 'openai';
  inputTokens: number;
  outputTokens: number;
  inputMessages: { role: string; contentLength: number }[];
  retrievedChunkIds: string[];
  durationMs: number;
  status: 'success' | 'error';
  errorMessage?: string;
  inputText?: string;
  outputText?: string;
}

type LlmAuditHook = (entry: LlmAuditEntry) => Promise<void>;

let _hook: LlmAuditHook | null = null;

/**
 * Register an audit hook (called by EE plugin at startup).
 */
export function setLlmAuditHook(hook: LlmAuditHook): void {
  _hook = hook;
}

/**
 * Emit an audit entry. Fire-and-forget — MUST NOT add latency to LLM responses.
 * In CE mode (no hook registered), this is a no-op with zero overhead.
 */
export function emitLlmAudit(entry: LlmAuditEntry): void {
  if (!_hook) return;
  _hook(entry).catch(() => {});
}

/**
 * Estimate token count from text length when provider doesn't return counts.
 * Rough approximation: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
