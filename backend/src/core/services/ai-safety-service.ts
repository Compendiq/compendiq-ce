import { query, getPool } from '../db/postgres.js';
import { logAuditEvent } from './audit-service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AiGuardrails {
  noFabricationInstruction: string;
  noFabricationEnabled: boolean;
}

export type ReferenceAction = 'flag' | 'strip' | 'off';

export interface AiOutputRules {
  stripReferences: boolean;
  referenceAction: ReferenceAction;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_NO_FABRICATION_INSTRUCTION =
  'IMPORTANT: Do not fabricate, invent, or hallucinate references, sources, URLs, citations, or bibliographic entries. If you do not have a verified source for a claim, say so explicitly. Never generate fake links or made-up author names. Only cite sources that were provided to you in the context.';

const DEFAULT_GUARDRAILS: AiGuardrails = {
  noFabricationInstruction: DEFAULT_NO_FABRICATION_INSTRUCTION,
  noFabricationEnabled: true,
};

const DEFAULT_OUTPUT_RULES: AiOutputRules = {
  stripReferences: true,
  referenceAction: 'flag',
};

// ─── In-process TTL cache (critic fix #3) ─────────────────────────────────────

const CACHE_TTL_MS = 60_000; // 60 seconds

let guardrailCache: { value: AiGuardrails; expiresAt: number } | null = null;
let outputRuleCache: { value: AiOutputRules; expiresAt: number } | null = null;

const AI_SAFETY_KEYS = [
  'ai_guardrail_no_fabrication',
  'ai_guardrail_no_fabrication_enabled',
  'ai_output_rule_strip_references',
  'ai_output_rule_reference_action',
] as const;

async function getAiSettingsMap(): Promise<Record<string, string>> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value
     FROM admin_settings
     WHERE setting_key = ANY($1::text[])`,
    [AI_SAFETY_KEYS as unknown as string[]],
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.setting_key] = row.setting_value;
  }
  return map;
}

// ─── Getters (with TTL cache) ─────────────────────────────────────────────────

export async function getAiGuardrails(): Promise<AiGuardrails> {
  if (guardrailCache && Date.now() < guardrailCache.expiresAt) {
    return guardrailCache.value;
  }
  const map = await getAiSettingsMap();
  const value: AiGuardrails = {
    noFabricationInstruction:
      map['ai_guardrail_no_fabrication'] ?? DEFAULT_GUARDRAILS.noFabricationInstruction,
    noFabricationEnabled:
      map['ai_guardrail_no_fabrication_enabled'] !== 'false',
  };
  guardrailCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function getAiOutputRules(): Promise<AiOutputRules> {
  if (outputRuleCache && Date.now() < outputRuleCache.expiresAt) {
    return outputRuleCache.value;
  }
  const map = await getAiSettingsMap();
  const action = map['ai_output_rule_reference_action'];
  const value: AiOutputRules = {
    stripReferences:
      map['ai_output_rule_strip_references'] !== 'false',
    referenceAction:
      action === 'strip' || action === 'flag' || action === 'off'
        ? action
        : DEFAULT_OUTPUT_RULES.referenceAction,
  };
  outputRuleCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

// ─── Setters (invalidate cache + audit log) ───────────────────────────────────

export async function upsertAiGuardrails(
  updates: Partial<AiGuardrails>,
  userId?: string,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    if (updates.noFabricationInstruction !== undefined) {
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('ai_guardrail_no_fabrication', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [updates.noFabricationInstruction],
      );
    }
    if (updates.noFabricationEnabled !== undefined) {
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('ai_guardrail_no_fabrication_enabled', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [String(updates.noFabricationEnabled)],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Invalidate cache
  guardrailCache = null;

  // Audit log (critic fix #6)
  if (userId) {
    await logAuditEvent(
      userId,
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      {
        action: 'update_ai_guardrails',
        changedFields: Object.keys(updates),
      },
    );
  }
}

export async function upsertAiOutputRules(
  updates: Partial<AiOutputRules>,
  userId?: string,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    if (updates.stripReferences !== undefined) {
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('ai_output_rule_strip_references', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [String(updates.stripReferences)],
      );
    }
    if (updates.referenceAction !== undefined) {
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('ai_output_rule_reference_action', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [updates.referenceAction],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Invalidate cache
  outputRuleCache = null;

  // Audit log (critic fix #6)
  if (userId) {
    await logAuditEvent(
      userId,
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      {
        action: 'update_ai_output_rules',
        changedFields: Object.keys(updates),
      },
    );
  }
}

/** Exposed for testing — reset both caches */
export function _resetCache(): void {
  guardrailCache = null;
  outputRuleCache = null;
}
