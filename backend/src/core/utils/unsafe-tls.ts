/**
 * Returns TLS connect options that disable certificate verification.
 *
 * INTENTIONALLY UNSAFE. This is the single, audited helper used by the
 * documented TLS escape hatches:
 *   - `LLM_VERIFY_SSL=false`        (consumed by `llm-config.ts`)
 *   - `CONFLUENCE_VERIFY_SSL=false` (consumed by `tls-config.ts`)
 *
 * Both flags default to verification-on; an operator must explicitly opt
 * in to the bypass. Each call site also logs a runtime warning and is
 * documented in `CLAUDE.md` / `.env.example`. Prefer `NODE_EXTRA_CA_CERTS`
 * (or the OS CA bundle, which both modules auto-detect) over disabling
 * verification.
 *
 * Centralising the unsafe object literal here means semgrep needs to
 * suppress exactly one line in the codebase — every other module gets to
 * stay clean — and any future audit of "where do we drop TLS verification?"
 * is a single grep for callers of this function.
 */
export function unsafeDisableTlsVerification(): { rejectUnauthorized: false } {
  // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- single, audited usage; gating happens at callsite via env var, runtime warning logged, NODE_EXTRA_CA_CERTS preferred
  return { rejectUnauthorized: false };
}
