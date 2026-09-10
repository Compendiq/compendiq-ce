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
  provider: string;
  inputTokens: number;
  outputTokens: number;
  inputMessages: { role: string; contentLength: number }[];
  retrievedChunkIds: string[];
  durationMs: number;
  status: 'success' | 'error';
  errorMessage?: string;
  inputText?: string;
  outputText?: string;
  /**
   * `true` when the prompt-injection heuristic flagged the input before the
   * LLM call. Undefined at call sites that haven't run the detector.
   * (#307 P0f — used by the Compliance Report's LLM-safety attestation.)
   */
  promptInjectionDetected?: boolean;
  /**
   * `true` when `sanitize-llm-input.ts` rewrote the input before sending
   * to the upstream. Undefined when the sanitiser was not invoked.
   * (#307 P0f.)
   */
  sanitized?: boolean;
  /**
   * #1115 P4 — how many knowledge-base images the request attached as
   * `image_url` parts, and their total size in RAW bytes (not base64).
   *
   * Both are OPTIONAL and both are absent, never 0, when the answer was
   * text-only — which is every answer on a deployment with no image leg and
   * every answer from a model that has not probed vision-capable. The EE
   * writer has to be able to tell "this call site does not report it" from
   * "it reported none", and every row written before P4 is the former.
   * Adding optional fields is compatible with that consumer; renaming or
   * requiring one is not.
   *
   * They count what was SENT, not what was picked or considered. A candidate
   * that was skipped (missing bytes, an unreadable header, past a #1154
   * ceiling, past the byte budget) cost the provider nothing and belongs in
   * the route's log line, not in an attestation of what the model saw.
   *
   * Deliberately numbers only — no attachment key, no page id and obviously
   * no bytes. `inputMessages[].contentLength` goes through `contentToText`,
   * which drops image parts, so no base64 reaches this entry by any path.
   */
  retrievedImageCount?: number;
  retrievedImageBytes?: number;
}

/**
 * Admin-event variant of the audit entry — used by config/admin routes
 * (provider CRUD, use-case assignment updates, etc.) where there is no
 * inference happening. Metadata is a free-form bag of ids / field names /
 * etc. Kept as a separate shape so the inference hook stays strict.
 *
 * @public Forward-compat extension-point payload (PR #259). Five CE
 * route call sites already emit admin entries through `emitLlmAudit`;
 * the EE writer will be wired via `setLlmAdminAuditHook`.
 */
export interface LlmAdminAuditEntry {
  event:
    | 'llm_provider_created'
    | 'llm_provider_updated'
    | 'llm_provider_deleted'
    | 'llm_provider_set_default'
    | 'llm_usecase_assignments_updated'
    /** #1184 — an admin forced a fresh vision probe of the resolved chat pair. */
    | 'llm_vision_capability_reprobed'
    /**
     * #1115 — an admin forced a fresh image-embedding probe. Worth auditing
     * beyond the vision case: a successful re-probe can retype the image
     * column, empty `page_image_embeddings` and re-dirty the whole corpus.
     */
    | 'llm_image_embedding_reprobed';
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
 *
 * @public Registration surface for the EE plugin; pairs with
 * `LlmAdminAuditEntry`. Symmetric to `setLlmAuditHook`.
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
