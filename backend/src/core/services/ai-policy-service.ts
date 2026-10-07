import type { PoolClient } from 'pg';
import { getPool } from '../db/postgres.js';
import { isSystemAdmin, userHasPermission } from './rbac-service.js';
import { getEnterprisePlugin } from '../enterprise/loader.js';
import { emitAiPolicyEvent } from '../enterprise/ai-policy-hooks.js';

/**
 * Article AI policy (SPEC-CORE-001/003). `pages.ai_policy` is the single
 * authority; labels only seed it at creation and can only make it stricter.
 */
export type AiPolicy = 'all' | 'local_only' | 'none';

const RANK: Record<AiPolicy, number> = { all: 0, local_only: 1, none: 2 };

export function isAiPolicy(value: unknown): value is AiPolicy {
  return value === 'all' || value === 'local_only' || value === 'none';
}

export function stricterPolicy(a: AiPolicy, b: AiPolicy): AiPolicy {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Mirrors SQL `ai_policy_from_labels` in migration 135. */
export function normalizeAiPolicyLabel(label: string): AiPolicy | null {
  const key = label.trim().toLowerCase().replace(/[\s_:]+/g, '-');
  if (key === 'ai-none' || key === 'no-ai') return 'none';
  if (key === 'ai-local-only' || key === 'ai-local') return 'local_only';
  return null;
}

export function policyFromLabels(labels: readonly string[] | null | undefined): AiPolicy {
  let out: AiPolicy = 'all';
  for (const l of labels ?? []) {
    const p = normalizeAiPolicyLabel(l);
    if (p) out = stricterPolicy(out, p);
  }
  return out;
}

/** Advisory-lock namespace shared by policy mutations and admission. */
export const AI_POLICY_LOCK_NAMESPACE = 0x41_49_50; // 'AIP'

/**
 * Permissions that confer policy authority on a Confluence-backed page.
 * Read-only roles carry none of them.
 */
const POLICY_PERMISSIONS = ['edit', 'page:edit', 'edit:page', 'pages:edit'];

/**
 * Policy authority. Standalone pages: the owner (or a system admin) only —
 * `visibility = 'shared'` grants editing content, never policy. Space pages:
 * an edit permission in the space (honouring page ACEs) or system admin.
 */
export async function canMutateAiPolicy(
  userId: string,
  pageId: number,
  client: PoolClient,
): Promise<boolean> {
  const r = await client.query<{
    source: string; created_by_user_id: string | null; space_key: string | null; deleted_at: Date | null;
  }>(
    `SELECT source, created_by_user_id, space_key, deleted_at FROM pages WHERE id = $1`,
    [pageId],
  );
  const page = r.rows[0];
  if (!page || page.deleted_at) return false;
  if (await isSystemAdmin(userId, client)) return true;
  if (page.source === 'standalone') return page.created_by_user_id === userId;
  if (!page.space_key) return false;
  for (const perm of POLICY_PERMISSIONS) {
    if (await userHasPermission(userId, perm, page.space_key, pageId, client)) return true;
  }
  return false;
}

/**
 * Foundation-only deployments (no EE enforcement hook) refuse to ACTIVATE a
 * restrictive policy: storing `local_only`/`none` without workers that honour
 * it would be a false promise. Relaxing back to `all` is always allowed.
 */
export function isAiPolicyEnforcementAvailable(): boolean {
  return getEnterprisePlugin().aiPolicyEnforcementAvailable?.() === true;
}

export type AiPolicyMutationResult =
  | { ok: true; rows: Array<{ pageId: number; policy: AiPolicy; revision: number }> }
  | { ok: false; reason: 'stale_revision' | 'not_authorized' | 'not_found' | 'enforcement_unavailable'; pageIds: number[] };

/**
 * All-or-nothing update of one or more pages. Rows are locked in id order;
 * any missing, unauthorized or stale row rolls the whole request back.
 */
export async function updatePageAiPolicies(
  userId: string,
  policy: AiPolicy,
  items: Array<{ pageId: number; expectedRevision: number }>,
): Promise<AiPolicyMutationResult> {
  if (policy !== 'all' && !isAiPolicyEnforcementAvailable()) {
    return { ok: false, reason: 'enforcement_unavailable', pageIds: items.map((i) => i.pageId) };
  }
  const sorted = [...items].sort((a, b) => a.pageId - b.pageId);
  const ids = sorted.map((i) => i.pageId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [AI_POLICY_LOCK_NAMESPACE, id]);
    }
    const locked = await client.query<{ id: number; ai_policy: AiPolicy; ai_policy_revision: string }>(
      `SELECT id, ai_policy, ai_policy_revision FROM pages
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
      [ids],
    );
    const byId = new Map(locked.rows.map((r) => [r.id, r]));
    const fail = async (reason: 'stale_revision' | 'not_authorized' | 'not_found', pageIds: number[]) => {
      await client.query('ROLLBACK');
      return { ok: false as const, reason, pageIds };
    };
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return await fail('not_found', missing);
    const denied: number[] = [];
    for (const id of ids) if (!(await canMutateAiPolicy(userId, id, client))) denied.push(id);
    if (denied.length) return await fail('not_authorized', denied);
    const stale = sorted
      .filter((i) => Number(byId.get(i.pageId)!.ai_policy_revision) !== i.expectedRevision)
      .map((i) => i.pageId);
    if (stale.length) return await fail('stale_revision', stale);

    const updated = await client.query<{ id: number; ai_policy: AiPolicy; ai_policy_revision: string }>(
      `UPDATE pages SET ai_policy = $2, ai_policy_revision = ai_policy_revision + 1
        WHERE id = ANY($1::int[]) RETURNING id, ai_policy, ai_policy_revision`,
      [ids, policy],
    );
    await client.query('COMMIT');
    const rows = updated.rows
      .map((r) => ({ pageId: r.id, policy: r.ai_policy, revision: Number(r.ai_policy_revision) }))
      .sort((a, b) => a.pageId - b.pageId);
    for (const row of rows) {
      emitAiPolicyEvent({
        type: 'policy_changed',
        pageId: row.pageId,
        userId,
        from: byId.get(row.pageId)!.ai_policy,
        to: row.policy,
        revision: row.revision,
      });
    }
    return { ok: true, rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Interactive creation: stricter of the EE/CE creation default and the
 * labels. An explicit choice is honoured only when the creator holds policy
 * authority (always true for a new owner) and enforcement is available for
 * restrictive values; it still never drops below the labels.
 */
export async function resolveCreationAiPolicy(input: {
  userId: string;
  spaceKey: string | null;
  labels: readonly string[] | undefined;
  explicit?: AiPolicy;
}): Promise<AiPolicy> {
  const hook = getEnterprisePlugin().resolveAiPolicyCreationDefault;
  const raw = hook ? await hook({ userId: input.userId, spaceKey: input.spaceKey }) : 'all';
  const hookDefault: AiPolicy = isAiPolicy(raw) ? raw : 'none';
  const fromLabels = policyFromLabels(input.labels);
  if (input.explicit !== undefined) {
    if (input.explicit !== 'all' && !isAiPolicyEnforcementAvailable()) {
      return stricterPolicy(hookDefault, fromLabels);
    }
    return stricterPolicy(input.explicit, fromLabels);
  }
  return stricterPolicy(hookDefault, fromLabels);
}
