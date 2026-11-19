/**
 * The article-AI-policy binary door (#1881, migration 151).
 *
 * Every backend process registers the protocol version it enforces on its
 * `page_writer_runtimes` row. Pre-#1881 binaries omit the column and register
 * as 0; once the switch is on or any restriction exists they can no longer
 * register, and while one is still active no restriction can be stored. The
 * second half is a trigger on `pages` that raises SQLSTATE 55000 with the
 * constraint name below from inside whatever statement tried to tighten.
 *
 * This module is dependency-free on purpose: `page-write-admission.ts` reads
 * the version at registration and the activation service re-exports it, so
 * neither has to import the other.
 */

/** Increment only with a reviewed, migration-backed policy-enforcement cutover. */
export const AI_POLICY_ENFORCEMENT_VERSION = 1;

/** Constraint name carried by the tightening guard's 55000 error. */
export const AI_POLICY_RUNTIME_GUARD_CONSTRAINT = 'ai_policy_incompatible_runtime_active';

/**
 * TRUE when `err` is the tightening guard's refusal: a restrictive policy
 * write refused because a runtime that does not enforce the protocol is
 * active. HTTP maps it to 409 `ai_policy_enforcement_unavailable`; workers,
 * deferred ingestion and recovery treat it like any refused tightening and
 * stay pending — it clears once that runtime is fenced or quiesced.
 */
export function isAiPolicyRuntimeGuardError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === '55000' && constraint === AI_POLICY_RUNTIME_GUARD_CONSTRAINT;
}
