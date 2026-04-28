/**
 * CE default writer for `LlmAuditEntry` rows. Persists each entry into
 * `llm_audit_log` (migration 073). Registered via `setLlmAuditHook(...)`
 * during `app.ts` bootstrap so EE plugins can override or chain.
 *
 * Contract (Compendiq/compendiq-ee#115 P0f):
 *   - Fire-and-forget. Never throws into the LLM call path; insertion errors
 *     are logged at WARN and swallowed.
 *   - Plaintext prompts are NEVER persisted — only the SHA-256 hex hash of
 *     the concatenated input messages.
 *   - `prompt_injection_detected` and `sanitized` come straight from the
 *     entry's optional flags (undefined → FALSE column default).
 */
import { createHash } from 'node:crypto';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import type { LlmAuditEntry } from './llm-audit-hook.js';

/**
 * SHA-256 hex of the concatenated input-message contents. Used as the
 * `prompt_hash` column value. We avoid hashing JSON metadata (role, etc.)
 * so the hash is reproducible from any equivalent flat-content prompt.
 */
function hashPromptFromEntry(entry: LlmAuditEntry): string {
  // The CE call sites pass `inputText` for ad-hoc cases and otherwise we
  // synthesize a stable digest from the per-message length pairs (the only
  // shape preserved by the existing audit hook contract). Either way the
  // plaintext is never stored.
  const material =
    typeof entry.inputText === 'string' && entry.inputText.length > 0
      ? entry.inputText
      : entry.inputMessages.map((m) => `${m.role}:${m.contentLength}`).join('|');

  return createHash('sha256').update(material).digest('hex');
}

/**
 * Map a `LlmAuditEntry.action` into the `llm_audit_log.usecase` column.
 * The taxonomy in `llm_usecase_assignments.usecase` is
 * `chat | summary | quality | auto_tag | embedding`; the audit hook's
 * `action` is broader (`ask`, `improve`, `generate`, `tag`, `diagram` …),
 * so we keep the action verbatim. The column is intentionally TEXT so
 * EE consumers can layer additional values without a schema change.
 */
function usecaseFromAction(action: LlmAuditEntry['action']): string {
  return action;
}

/**
 * The CE default writer. Inserts one row per call. Errors never propagate.
 *
 * Returns a Promise so `emitLlmAudit()`'s `.catch(() => {})` chain works,
 * but resolves successfully even on insert failure (errors are logged).
 */
export async function defaultLlmAuditWriter(entry: LlmAuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO llm_audit_log (
         user_id,
         provider_id,
         provider_name,
         model,
         usecase,
         prompt_hash,
         prompt_token_count,
         completion_token_count,
         prompt_injection_detected,
         sanitized,
         latency_ms,
         error
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.userId,
        // CE writer does not currently surface a provider UUID through the
        // audit entry shape; EE writers that need the FK can override the
        // hook entirely. We snapshot the human-readable provider name for
        // Report 5 consumption.
        null,
        entry.provider,
        entry.model,
        usecaseFromAction(entry.action),
        hashPromptFromEntry(entry),
        entry.inputTokens,
        entry.outputTokens,
        entry.promptInjectionDetected ?? false,
        entry.sanitized ?? false,
        entry.durationMs,
        entry.status === 'error' ? entry.errorMessage ?? 'unknown error' : null,
      ],
    );
  } catch (err) {
    // Never block the LLM call path on the audit insert. Log + swallow.
    logger.warn(
      { err, action: entry.action, userId: entry.userId },
      'llm_audit_log insert failed (fire-and-forget)',
    );
  }
}
