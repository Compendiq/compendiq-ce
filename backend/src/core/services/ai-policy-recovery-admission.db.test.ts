import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { applyAiPolicyOnClient, assertLabelPolicyChangeOnClient } from './ai-policy-service.js';
import { _resetAiPolicyActivationForTests, setAiPolicyEnforcementForTest } from './ai-policy-activation.js';

const available = await isDbAvailable();
describe.skipIf(!available)('recovery policy admission always validates the journal', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { _resetAiPolicyActivationForTests(); await teardownTestDb(); });
  it.each([false, true])('rejects an unknown journal even for unchanged policy (ready=%s)', async (ready) => {
    // The real switch row, not a plugin spy (#1881): the journal check must
    // not depend on whether new tightening is open.
    await setAiPolicyEnforcementForTest(ready);
    const actor = randomUUID();
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid,$1::text,'x','admin')`, [actor]);
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, source, visibility, created_by_user_id, ai_policy, labels)
      VALUES ('Recovery', 'standalone', 'private', $1, 'all', ARRAY['all-ai']) RETURNING id`, [actor]);
    const pageId = inserted.rows[0]!.id;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const plan = { policy: 'all' as const, kind: 'unchanged' as const, labels: ['all-ai'], restoredLabel: null };
      await expect(assertLabelPolicyChangeOnClient(client, { userId: actor, pageId, plan,
        recoveryIntentId: randomUUID() })).rejects.toMatchObject({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' });
      await expect(assertLabelPolicyChangeOnClient(client, { userId: actor, pageId, plan })).resolves.toBeUndefined();
      await expect(applyAiPolicyOnClient(client, {
        userId: actor, items: [{ pageId, policy: 'all', expectedRevision: 0 }],
        recovery: { intentId: randomUUID(), targetLabels: ['all-ai'] },
      })).rejects.toMatchObject({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' });
      await client.query("UPDATE pages SET ai_policy = 'local_only', ai_policy_revision = 1 WHERE id=$1", [pageId]);
      await expect(applyAiPolicyOnClient(client, {
        userId: actor, items: [{ pageId, policy: 'all', expectedRevision: 1 }],
        recovery: { intentId: randomUUID(), targetLabels: ['all-ai'] },
      })).rejects.toMatchObject({ statusCode: 409, reason: 'intent_recovery_metadata_invalid' });
      expect((await client.query('SELECT ai_policy, ai_policy_revision FROM pages WHERE id=$1', [pageId])).rows[0])
        .toEqual({ ai_policy: 'local_only', ai_policy_revision: '1' });
      await client.query("UPDATE pages SET ai_policy = 'all', ai_policy_revision = 2 WHERE id=$1", [pageId]);
      expect((await client.query('SELECT ai_policy, ai_policy_revision, labels FROM pages WHERE id=$1', [pageId])).rows[0])
        .toEqual({ ai_policy: 'all', ai_policy_revision: '2', labels: ['all-ai'] });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
