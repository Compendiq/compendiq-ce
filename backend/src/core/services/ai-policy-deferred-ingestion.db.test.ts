import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { ingestionSourceId, observeIngestionAdmission, publishIngestionPolicyOnClient, reconcileDeferredIngestionPolicy } from './ai-policy-deferred-ingestion.js';
import { admitAutomaticIngestionPolicy } from './ai-policy-ingestion.js';
import { isAiPolicyEnforcementAvailable } from './ai-policy-service.js';

const available = await isDbAvailable();
const sql = fs.readFileSync(new URL('../db/migrations/139_ai_policy_deferred_ingestion.sql', import.meta.url), 'utf8');
describe.skipIf(!available)('durable deferred ingestion (real readiness, real PG)', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });
  it('normalizes Notion observation aliases without normalizing Confluence IDs', async () => {
    const actor = randomUUID();
    const sourceId = randomUUID().toUpperCase();
    const key = sourceId.replace(/-/g, '').toLowerCase();
    expect(ingestionSourceId('notion', sourceId)).toBe(key);
    expect(ingestionSourceId('confluence', sourceId)).toBe(sourceId);
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid,$1::text,'x','admin')`, [actor]);
    const observation = { source: 'notion' as const, sourceScope: actor, sourceId,
      observedRevision: '1', userId: actor, policy: 'none' as const };
    await expect(observeIngestionAdmission(observation, async (_client, policy) =>
      admitAutomaticIngestionPolicy({ identity: sourceId, currentPolicy: 'all', candidate: policy })))
      .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    // The next snapshot has removed the label and uses the other wire spelling.
    // It must still encounter the original observation rather than publish all.
    await expect(observeIngestionAdmission({ ...observation, sourceId: key, policy: 'all', observedRevision: '2' },
      async (_client, policy) => {
        expect(policy).toBe('none');
        return admitAutomaticIngestionPolicy({ identity: key, currentPolicy: 'all', candidate: policy });
      })).rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    const rows = await query('SELECT source_id, applied_at FROM ai_policy_deferred_ingestion WHERE source_scope=$1', [actor]);
    expect(rows.rows).toEqual([{ source_id: key, applied_at: null }, { source_id: key, applied_at: null }]);
    await query('DELETE FROM ai_policy_deferred_ingestion WHERE source_scope=$1', [actor]);
  });
  it('rolls back fresh publication without consuming deferred intent while readiness is closed', async () => {
    const actor = randomUUID();
    const sourceId = randomUUID();
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid,$1::text,'x','admin')`, [actor]);
    const observation = { source: 'notion' as const, sourceScope: actor, sourceId,
      observedRevision: '1', userId: actor, policy: 'none' as const };
    await expect(observeIngestionAdmission(observation, async (_client, policy) =>
      admitAutomaticIngestionPolicy({ identity: sourceId, currentPolicy: 'all', candidate: policy })))
      .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    const client = await getPool().connect();
    let pageId: number;
    try {
      await client.query('BEGIN');
      pageId = (await client.query<{ id: number }>(`INSERT INTO pages
        (title, source, visibility, created_by_user_id, notion_page_id, labels)
        VALUES ('Fresh', 'standalone', 'private', $1, $2, ARRAY['all-ai']) RETURNING id`, [actor, sourceId])).rows[0]!.id;
      await expect(publishIngestionPolicyOnClient(client, { ...observation, pageId, candidate: 'all' }))
        .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await query('SELECT id FROM pages WHERE id=$1', [pageId!])).rowCount).toBe(0);
    expect((await query('SELECT applied_at FROM ai_policy_deferred_ingestion WHERE source_scope=$1', [actor])).rows)
      .toEqual([{ applied_at: null }]);
    await query('DELETE FROM ai_policy_deferred_ingestion WHERE source_scope=$1', [actor]);
  });
  it('is idempotent, never changes applied policy, and stays inert while closed', async () => {
    await query(sql);
    await query(sql);
    const actor = randomUUID();
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid,$1::text,'x','admin')`, [actor]);
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, source, visibility, created_by_user_id, notion_page_id)
      VALUES ('Deferred', 'standalone', 'private', $1, 'notion-deferred') RETURNING id`, [actor]);
    const pageId = inserted.rows[0]!.id;
    expect(isAiPolicyEnforcementAvailable()).toBe(false);
    const observation = { source: 'notion' as const, sourceScope: actor, sourceId: 'notion-deferred',
      observedRevision: '1', userId: actor, policy: 'none' as const };
    for (let i = 0; i < 2; i++) {
      await expect(observeIngestionAdmission(observation, async (_client, policy) =>
        admitAutomaticIngestionPolicy({ identity: observation.sourceId, currentPolicy: 'all', candidate: policy })))
        .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    }
    expect((await query('SELECT count(*)::int AS n FROM ai_policy_deferred_ingestion')).rows[0].n).toBe(1);
    expect(await reconcileDeferredIngestionPolicy({ ...observation, pageId })).toBe(0);
    expect((await query('SELECT ai_policy, ai_policy_revision FROM pages WHERE id=$1', [pageId])).rows[0])
      .toEqual({ ai_policy: 'all', ai_policy_revision: '0' });
    expect((await query('SELECT applied_at FROM ai_policy_deferred_ingestion')).rows[0].applied_at).toBeNull();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(`INSERT INTO ai_policy_deferred_ingestion
        (id,source,source_scope,source_id,observed_revision,policy,observed_by)
        VALUES ($1,'notion',$2::text,'bad','1','all',$2::uuid)`, [randomUUID(), actor]))
        .rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
