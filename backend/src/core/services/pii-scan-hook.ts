/**
 * Extension point for PII scanning of AI output (EE #119).
 *
 * CE builds install no hook — scanForPii returns null and inference
 * routes skip any PII handling (zero overhead). The EE plugin registers
 * a synchronous scanner at `registerRoutes()` time; when registered,
 * inference routes call `scanForPii` after generation and before
 * persistence/audit to:
 *   - attach detection spans to the audit entry, and
 *   - optionally block/redact output per the admin policy.
 *
 * Mirrors the llm-audit-hook pattern. The sync contract (not
 * fire-and-forget like audit) is required because redact/block modes
 * must be able to mutate or reject the output before it is committed.
 */

/**
 * The action type under which the scan is being performed. Matches the
 * llm-audit-hook action taxonomy + 'auto_tag' for the pages-tags path.
 */
export type PiiScanAction =
  | 'chat'
  | 'improve'
  | 'summary'
  | 'generate'
  | 'auto_tag';

export interface PiiSpan {
  start: number;
  end: number;
  category: string;
  confidence: number;
  source: 'regex' | 'ner' | 'llm-judge';
}

export interface PiiScanResult {
  spans: PiiSpan[];
  action: 'flag-only' | 'redacted' | 'blocked';
  redactedText?: string;
}

type PiiScanHook = (
  text: string,
  action: PiiScanAction,
  opts?: { async?: boolean },
) => Promise<PiiScanResult>;

let hook: PiiScanHook | null = null;

/**
 * Install the EE-side PII scanner. Call from the enterprise plugin's
 * `registerRoutes()` during startup. Pass `null` to uninstall.
 */
export function setPiiScanHook(fn: PiiScanHook | null): void {
  hook = fn;
}

/**
 * Run the installed PII scanner, or return null if none is registered
 * (CE mode). The caller treats null as "no scanning" and proceeds with
 * the original output unmodified.
 */
export async function scanForPii(
  text: string,
  action: PiiScanAction,
  opts?: { async?: boolean },
): Promise<PiiScanResult | null> {
  if (!hook) return null;
  try {
    return await hook(text, action, opts);
  } catch {
    // Fail-open on scanner errors — never block the user's request
    // because the scanner misbehaved. The EE scanner logs internally.
    return null;
  }
}

/** Test helper — reset hook between test cases. */
export function _resetPiiScanHookForTests(): void {
  hook = null;
}
