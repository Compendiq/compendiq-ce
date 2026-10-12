/**
 * #281 — label writers publish their policy consequence through
 * `applyPageLabelsOnClient` on the transaction they already hold. Real
 * PostgreSQL; no DB mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { applyPageLabelsOnClient } from './ai-policy-service.js';
import { PageWriteError } from './page-write-admission.js';
import { applyLabelChanges } from '../../domains/knowledge/services/auto-tagger.js';

const dbAvailable = await isDbAvailable();
let seq = 0;

async function user(role = 'user'): Promise<string> {
  seq += 1;
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`lw${seq}`, `lw${seq}@test.invalid`, role],
  );
  return r.rows[0]!.id;
}

async function page(input: { owner: string; labels: string[]; policy?: string; revision?: number; visibility?: string }): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_storage, body_text, version, labels, source, visibility,
                        created_by_user_id, ai_policy, ai_policy_revision, embedding_dirty, embedding_status)
     VALUES ('T', '<p>b</p>', '<p>b</p>', 'b', 1, $2, 'standalone', $5, $1, $3, $4, FALSE, 'not_embedded')
     RETURNING id`,
    [input.owner, input.labels, input.policy ?? 'all', input.revision ?? 0, input.visibility ?? 'private'],
  );
  return r.rows[0]!.id;
}

async function state(id: number) {
  const r = await query<{
    labels: string[]; ai_policy: string; ai_policy_revision: string; embedding_status: string;
    summary_status: string; ai_policy_block_reason: string | null;
  }>(
    `SELECT labels, ai_policy, ai_policy_revision::text, embedding_status, summary_status, ai_policy_block_reason
       FROM pages WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe.skipIf(!dbAvailable)('label writers → applyPageLabelsOnClient (#281)', () => {
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it('a newly added restrictive label tightens; policy, revision, labels and purge are one commit', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const applied = await applyPageLabelsOnClient(client, { userId: owner, pageId: id, targetLabels: ['one', 'AI_None'] });
      expect(applied).toMatchObject({ labels: ['one', 'no-ai'], policy: 'none', revision: 1 });
      expect(applied.changes).toEqual([{ pageId: id, userId: owner, from: 'all', to: 'none', revision: 1 }]);
      expect((await state(id)).ai_policy).toBe('all'); // invisible until COMMIT
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await state(id)).toMatchObject({
      labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '1',
      embedding_status: 'policy_blocked', summary_status: 'policy_blocked', ai_policy_block_reason: 'policy_none',
    });
  });

  it('a carried-over label is inert after an explicit relaxation: policy and revision stay', async () => {
    const owner = await user();
    // Creation tightened the page from its label (migration 135 trigger); the
    // policy endpoint then relaxed it to `all` at revision 1 and the label
    // remained behind.
    const id = await page({ owner, labels: ['no-ai'] });
    expect(await state(id)).toMatchObject({ ai_policy: 'none' });
    await query(`UPDATE pages SET ai_policy = 'all', ai_policy_revision = 1 WHERE id = $1`, [id]);
    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'x'] }));
    expect(applied).toMatchObject({ labels: ['no-ai', 'x'], policy: 'all', revision: 1, changes: [] });
    expect(await state(id)).toMatchObject({ labels: ['no-ai', 'x'], ai_policy: 'all', ai_policy_revision: '1', embedding_status: 'not_embedded' });
  });

  it('contradictory reserved labels are a 422 and nothing is written', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['no-ai', 'ai-local-only'] })),
    ).rejects.toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    expect(await state(id)).toMatchObject({ labels: ['one'], ai_policy: 'all', ai_policy_revision: '0' });
  });

  it('removing the canonical label does not relax: it is restored and the revision stays', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['no-ai', 'one'], policy: 'none' });
    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['one'] }));
    expect(applied.plan.restoredLabel).toBe('no-ai');
    expect(applied.changes).toEqual([]);
    expect(await state(id)).toMatchObject({ labels: ['one', 'no-ai'], ai_policy: 'none', ai_policy_revision: '0' });
  });

  it('an explicit relaxation label needs policy authority (shared editors have none)', async () => {
    const owner = await user();
    const editor = await user();
    const id = await page({ owner, labels: ['no-ai'], policy: 'none', visibility: 'shared' });
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: editor, pageId: id, targetLabels: ['all-ai'] })),
    ).rejects.toMatchObject({ statusCode: 403, reason: 'ai_policy_not_authorized' });
    expect(await state(id)).toMatchObject({ labels: ['no-ai'], ai_policy: 'none', ai_policy_revision: '0' });

    const applied = await tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: id, targetLabels: ['all-ai'] }));
    expect(applied).toMatchObject({ labels: ['all-ai'], policy: 'all', revision: 1 });
    expect(await state(id)).toMatchObject({
      labels: ['all-ai'], ai_policy: 'all', ai_policy_revision: '1', embedding_status: 'not_embedded', ai_policy_block_reason: null,
    });
  });

  it('a missing page is a PageWriteError 404', async () => {
    const owner = await user();
    await expect(
      tx((c) => applyPageLabelsOnClient(c, { userId: owner, pageId: 999_999, targetLabels: ['x'] })),
    ).rejects.toBeInstanceOf(PageWriteError);
  });

  it('applyLabelChanges (local branch) runs end to end through the primitive', async () => {
    const owner = await user();
    const id = await page({ owner, labels: ['one'] });
    expect(await applyLabelChanges(owner, String(id), { add: ['ai-local'] })).toEqual(['one', 'ai-local-only']);
    expect(await state(id)).toMatchObject({ ai_policy: 'local_only', ai_policy_revision: '1', embedding_status: 'not_embedded' });

    await expect(applyLabelChanges(owner, String(id), { add: ['no-ai'] }))
      .rejects.toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    expect(await state(id)).toMatchObject({ ai_policy: 'local_only', ai_policy_revision: '1' });

    expect(await applyLabelChanges(owner, String(id), { add: [], remove: ['ai-local-only'] })).toEqual(['one', 'ai-local-only']);
    expect(await state(id)).toMatchObject({ ai_policy: 'local_only', ai_policy_revision: '1' });
  });
});
