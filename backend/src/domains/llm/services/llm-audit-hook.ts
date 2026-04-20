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

/**
 * Admin-event variant of the audit entry — used by config/admin routes
 * (provider CRUD, use-case assignment updates, etc.) where there is no
 * inference happening. Metadata is a free-form bag of ids / field names /
 * etc. Kept as a separate shape so the inference hook stays strict.
 */
export interface LlmAdminAuditEntry {
  event:
    | 'llm_provider_created'
    | 'llm_provider_updated'
    | 'llm_provider_deleted'
    | 'llm_provider_set_default'
    | 'llm_usecase_assignments_updated';
  userId: string | null;
  metadata?: Record<string, unknown>;
}

type LlmAuditHook = (entry: LlmAuditEntry) => Promise<void>;
type LlmAdminAuditHook = (entry: LlmAdminAuditEntry) => Promise<void>;

let _hook: LlmAuditHook | null = null;
let _adminHook: LlmAdminAuditHook | null = null;

/**
 * Register an audit hook (called by EE plugin at startup).
 */
export function setLlmAuditHook(hook: LlmAuditHook): void {
  _hook = hook;
}

/**
 * Register an admin-event audit hook (called by EE plugin at startup).
 * In CE mode this stays null — admin events are a no-op.
 */
export function setLlmAdminAuditHook(hook: LlmAdminAuditHook): void {
  _adminHook = hook;
}

function isAdminEntry(e: LlmAuditEntry | LlmAdminAuditEntry): e is LlmAdminAuditEntry {
  return typeof (e as LlmAdminAuditEntry).event === 'string';
}

/**
 * Emit an audit entry. Fire-and-forget — MUST NOT add latency to LLM responses.
 * In CE mode (no hook registered), this is a no-op with zero overhead.
 *
 * Accepts either an inference entry (`LlmAuditEntry`) or an admin-event entry
 * (`LlmAdminAuditEntry`); routes to the appropriate hook.
 */
export function emitLlmAudit(entry: LlmAuditEntry | LlmAdminAuditEntry): void {
  if (isAdminEntry(entry)) {
    if (!_adminHook) return;
    _adminHook(entry).catch(() => {});
    return;
  }
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
