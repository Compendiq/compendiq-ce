/**
 * CE default writer for `LlmAuditEntry` rows. Persists each entry into
 * `llm_audit_log` (migration 073). Registered via `setLlmAuditHook(...)`
 * during `app.ts` bootstrap so EE plugins can override or chain.
 *
 * Contract (Compendiq/compendiq-ee#115 P0f):
 *   - Fire-and-forget. Never throws into the LLM call path; insertion errors
 *     are logged at WARN and swallowed.
 *   - Plaintext prompts are never supplied to this writer; `prompt_hash` is
 *     the digest computed from the provider prompt by the producer.
 *   - `prompt_injection_detected` and `sanitized` come straight from the
 *     entry's optional flags (undefined → FALSE column default).
 *
 * Column choice rationale: the column names below intentionally match
 * the columns shared between CE migration 073 and the pre-existing EE
 * migration 060 so this writer works in both deployments without
 * runtime schema detection. The new P0f columns (`prompt_hash`,
 * `prompt_injection_detected`, `sanitized`) are added to the EE table
 * by 073 via `ALTER TABLE ADD COLUMN IF NOT EXISTS`.
 */
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import type { LlmAuditEntry } from './llm-audit-hook.js';


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
         action,
         model,
         provider,
         input_tokens,
         output_tokens,
         duration_ms,
         status,
         error_message,
         prompt_hash,
         prompt_injection_detected,
         sanitized
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.userId,
        entry.action,
        entry.model,
        entry.provider,
        entry.inputTokens,
        entry.outputTokens,
        entry.durationMs,
        entry.status,
        entry.status === 'error' ? entry.errorMessage ?? 'unknown error' : null,
        entry.promptHash,
        entry.promptInjectionDetected ?? false,
        entry.sanitized ?? false,
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
